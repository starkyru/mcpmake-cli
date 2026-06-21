/**
 * Crawls a website using Playwright, visiting pages breadth-first
 * and extracting interactive elements from each page.
 */

import { chromium } from 'playwright';
import type { Browser, Page, Request, Response } from 'playwright';
import type { Entry, Header } from 'har-format';
import type { SiteDescriptor, PageDescriptor } from '../types/site.js';
import { parsePage, isSameOrigin } from './dom-parser.js';
import { makeNavigationHopRouteHandler } from './same-origin.js';
import { captureViewportScreenshot } from './screenshot-capture.js';
import { logger } from '../utils/logger.js';
import { assertPublicUrl } from '../utils/ssrf-guard.js';
import crypto from 'node:crypto';

export interface CrawlOptions {
  /** Target URL to start crawling from */
  url: string;
  /** Maximum crawl depth (default: 2) */
  depth?: number;
  /** Maximum number of pages to visit (default: 20) */
  maxPages?: number;
  /** Idle timeout in ms before auto-closing (default: 5 min) */
  timeout?: number;
  /** Run browser in headless mode (default: false) */
  headless?: boolean;
  /** Viewport dimensions */
  viewport?: { width: number; height: number };
  /** Whether to capture screenshots during analysis (default: true) */
  captureScreenshots?: boolean;
  /** Whether to capture HAR entries during crawl (for hybrid mode) */
  captureHar?: boolean;
}

export interface CrawlResult {
  siteDescriptor: SiteDescriptor;
  /** Screenshots keyed by pageId */
  screenshots: Map<string, Buffer>;
  /** HAR entries captured during the crawl (only when captureHar is true) */
  harEntries?: Entry[];
}

const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_TIMEOUT = 5 * 60 * 1000;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
// Defense-in-depth bound on the in-flight request map during HAR capture.
const MAX_PENDING = 10_000;
// Cap the BFS frontier so an adversarial/large site can't balloon the queue.
// We never need more than maxPages worth of unvisited work plus a small margin,
// since extra queued URLs beyond the page cap would never be visited anyway.
const MAX_FRONTIER_MULTIPLIER = 10;

/**
 * Crawl a website and return a SiteDescriptor with all discovered pages.
 */
export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const captureScreenshots = options.captureScreenshots ?? true;

  const parsedUrl = new URL(options.url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }
  // SSRF guard: refuse private/loopback/link-local/metadata start hosts before
  // we launch a browser at them. Resolves DNS and enforces protocol + host.
  await assertPublicUrl(options.url);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
  // Normalized origin used for same-origin admission. A string-prefix check on
  // baseUrl would admit prefix-spoofing hosts (e.g. example.com.attacker.test).
  const baseOrigin = parsedUrl.origin;

  const captureHar = options.captureHar ?? false;

  const pages: PageDescriptor[] = [];
  const screenshots = new Map<string, Buffer>();
  const harEntries: Entry[] = [];
  const pendingRequests = new Map<Request, { startTime: number }>();
  const visited = new Set<string>();
  // URLs already pushed onto the frontier (by normalized form). Dedup on enqueue
  // — not just on visit — so the same link discovered on many pages is queued
  // once and the frontier can't balloon. Seed with the start URL.
  const enqueued = new Set<string>();
  const maxFrontier = maxPages * MAX_FRONTIER_MULTIPLIER;
  const queue: Array<{ url: string; currentDepth: number }> = [];

  const enqueue = (url: string, currentDepth: number): void => {
    if (queue.length >= maxFrontier) return;
    const key = normalizeUrl(url);
    if (visited.has(key) || enqueued.has(key)) return;
    enqueued.add(key);
    queue.push({ url, currentDepth });
  };

  enqueue(options.url, 0);

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    // Per-hop SSRF guard: abort cross-origin *navigations/document loads* the
    // page itself issues (meta/JS redirect, window.location, fresh document) so
    // it can't steer the top-level page off the base origin to an internal
    // target. The queue-time isSameOrigin check (below) only vets links we choose
    // to enqueue. Subresources (including cross-origin ones) are allowed through
    // so pages still render. See navigationHopDecision.
    //
    // CAVEAT: Chromium follows a server 3xx redirect WITHOUT re-invoking
    // page.route, so a same-origin URL that 302s to an internal host is NOT
    // blocked at request time here — the post-goto landed-origin check below is
    // the backstop (we skip parsing a page that ended off-origin). The hosted
    // crawl additionally runs inside an egress-restricted network.
    await page.route('**/*', makeNavigationHopRouteHandler(baseOrigin));

    // Optionally capture network requests as HAR entries during crawl
    if (captureHar) {
      const onRequest = (request: Request) => {
        // Defense-in-depth bound: drop the oldest in-flight entry if a flood of
        // never-resolving requests ever fills the map.
        if (pendingRequests.size >= MAX_PENDING) {
          const oldest = pendingRequests.keys().next().value;
          if (oldest) pendingRequests.delete(oldest);
        }
        pendingRequests.set(request, { startTime: Date.now() });
      };
      const onResponse = async (response: Response) => {
        const request = response.request();
        const pending = pendingRequests.get(request);
        if (!pending) return;
        try {
          const entry = await buildCrawlHarEntry(request, response, pending.startTime);
          harEntries.push(entry);
        } catch {
          // Some responses can't be read (redirects, aborted)
        } finally {
          // Always free the pending entry, even on read failure, so the map
          // can't grow unbounded across a long crawl.
          pendingRequests.delete(request);
        }
      };
      // The nav-hop guard aborts cross-origin hops and many crawl requests
      // never fire 'response' (aborted/blocked/failed/redirect). Free their
      // pending entries on both terminal events so the map can't leak.
      const onSettled = (request: Request) => {
        pendingRequests.delete(request);
      };

      page.on('request', onRequest);
      page.on('response', onResponse);
      page.on('requestfailed', onSettled);
      page.on('requestfinished', onSettled);

      // Drop listeners when the browser disconnects so nothing is retained past
      // the crawl (they close over pendingRequests/harEntries).
      browser.on('disconnected', () => {
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfailed', onSettled);
        page.off('requestfinished', onSettled);
        pendingRequests.clear();
      });
    }

    logger.info(`Crawling site: ${options.url} (depth: ${depth}, max pages: ${maxPages})`);
    let lastActivityTime = Date.now();

    while (queue.length > 0 && pages.length < maxPages) {
      const item = queue.shift()!;
      const normalizedUrl = normalizeUrl(item.url);

      // Skip if already visited or different origin. Origin is compared via
      // parsed URL.origin, never a string prefix, so a malicious link to
      // `https://<base>.attacker.test` cannot pull the crawler off-origin.
      if (visited.has(normalizedUrl)) continue;
      if (!isSameOrigin(item.url, baseOrigin)) continue;

      visited.add(normalizedUrl);

      // Check idle timeout
      if (Date.now() - lastActivityTime > timeout) {
        logger.warn('Idle timeout reached during crawl');
        break;
      }

      try {
        // SSRF guard: re-check the host right before navigating. A discovered
        // link can be same-origin yet still resolve to a private/internal
        // address; refuse it without aborting the whole crawl.
        await assertPublicUrl(item.url);

        logger.info(`[${pages.length + 1}/${maxPages}] Visiting: ${item.url}`);
        await page.goto(item.url, {
          waitUntil: 'domcontentloaded',
          timeout: 15_000,
        });

        // Wait briefly for dynamic content to render
        await page.waitForTimeout(1000);

        lastActivityTime = Date.now();

        // Parse the page DOM
        const pageDescriptor = await parsePage(page);
        pageDescriptor.url = item.url;

        // Capture screenshot if enabled
        if (captureScreenshots) {
          const screenshot = await captureViewportScreenshot(page);
          pageDescriptor.screenshotHash = screenshot.hash;
          screenshots.set(pageDescriptor.pageId, screenshot.data);
        }

        pages.push(pageDescriptor);

        // Queue navigation links for further crawling. enqueue() dedups
        // against both visited and already-queued URLs and respects the
        // frontier cap, so the same link across pages is queued at most once.
        if (item.currentDepth < depth) {
          for (const link of pageDescriptor.links) {
            if (link.isNavigation && isSameOrigin(link.href, baseOrigin)) {
              enqueue(link.href, item.currentDepth + 1);
            }
          }
        }
      } catch (err) {
        logger.warn(`Failed to crawl ${item.url}: ${err}`);
      }
    }

    // Close browser
    await browser.close().catch(() => {});
    browser = undefined;
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    throw error;
  }

  logger.info(`Crawl complete: ${pages.length} pages discovered`);

  // Extract site metadata from the first page
  const metadata = {
    title: pages[0]?.title,
    description: undefined,
    favicon: undefined,
  };

  const siteDescriptor: SiteDescriptor = {
    siteId: generateSiteId(baseUrl),
    baseUrl,
    pages,
    analyzedAt: new Date().toISOString(),
    version: 1,
    crawlDepth: depth,
    metadata,
  };

  return {
    siteDescriptor,
    screenshots,
    ...(captureHar ? { harEntries } : {}),
  };
}

// ─── HAR Capture (for hybrid mode) ─────────────────────────────────

const MAX_RESPONSE_BODY_BYTES = 5 * 1024 * 1024;
const SKIP_BODY_MIME_TYPES = ['image/', 'video/', 'audio/', 'font/', 'application/octet-stream'];
// Large-by-nature Playwright resource types; skip body capture at the header
// level instead of buffering the whole response and discarding it afterwards.
const SKIP_BODY_RESOURCE_TYPES = new Set([
  'image',
  'media',
  'font',
  'stylesheet',
  'websocket',
  'eventsource',
  'manifest',
  'texttrack',
]);

async function buildCrawlHarEntry(
  request: Request,
  response: Response,
  startTime: number,
): Promise<Entry> {
  const elapsed = Date.now() - startTime;
  const url = request.url();
  const parsedUrl = new URL(url);

  const requestHeaders: Header[] = Object.entries(request.headers()).map(([name, value]) => ({
    name,
    value,
  }));
  const queryString = [...parsedUrl.searchParams.entries()].map(([name, value]) => ({
    name,
    value,
  }));
  const postData = request.postData();
  const contentTypeHeader = request.headers()['content-type'] ?? '';
  const responseHeaders: Header[] = Object.entries(response.headers()).map(([name, value]) => ({
    name,
    value,
  }));

  // Enforce the body cap at the header/resource-type level: once
  // `response.body()` resolves, Playwright has already buffered the whole
  // response, so a post-hoc length check can't protect memory against a
  // missing or dishonest Content-Length. Skip large-by-type resources and
  // over-cap declared lengths up front; the post-read check is only a backstop.
  let responseText: string | undefined;
  const responseMimeType = response.headers()['content-type'] ?? '';
  const skipBody =
    SKIP_BODY_MIME_TYPES.some((m) => responseMimeType.startsWith(m)) ||
    SKIP_BODY_RESOURCE_TYPES.has(request.resourceType());
  const rawContentLength = response.headers()['content-length'];
  const parsedLength = rawContentLength === undefined ? NaN : parseInt(rawContentLength, 10);
  const lengthKnown = Number.isFinite(parsedLength) && parsedLength >= 0;
  const tooLargeByHeader = lengthKnown && parsedLength > MAX_RESPONSE_BODY_BYTES;

  if (!skipBody && !tooLargeByHeader) {
    try {
      const body = await response.body();
      if (body.length <= MAX_RESPONSE_BODY_BYTES) {
        responseText = body.toString('utf-8');
      }
    } catch {
      // Body may not be available
    }
  }

  return {
    startedDateTime: new Date(startTime).toISOString(),
    time: elapsed,
    request: {
      method: request.method(),
      url,
      httpVersion: 'HTTP/1.1',
      headers: requestHeaders,
      queryString,
      cookies: [],
      headersSize: -1,
      bodySize: postData ? Buffer.byteLength(postData) : 0,
      ...(postData
        ? {
            postData: {
              mimeType: contentTypeHeader.split(';')[0].trim() || 'application/octet-stream',
              text: postData,
            },
          }
        : {}),
    },
    response: {
      status: response.status(),
      statusText: response.statusText(),
      httpVersion: 'HTTP/1.1',
      headers: responseHeaders,
      cookies: [],
      content: {
        size: responseText ? Buffer.byteLength(responseText) : 0,
        mimeType: responseMimeType.split(';')[0].trim() || 'application/octet-stream',
        ...(responseText ? { text: responseText } : {}),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: responseText ? Buffer.byteLength(responseText) : 0,
    },
    cache: {},
    timings: {
      send: 1,
      wait: Math.max(1, elapsed - 2),
      receive: 1,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slash, fragment, and normalize
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return url;
  }
}

function generateSiteId(baseUrl: string): string {
  const hash = crypto.createHash('sha256').update(baseUrl).digest('hex').slice(0, 12);
  return `site_${hash}`;
}
