/**
 * Crawls a website using Playwright, visiting pages breadth-first
 * and extracting interactive elements from each page.
 */

import { chromium } from 'playwright';
import type { Browser, Page, Request, Response } from 'playwright';
import type { Entry, Header } from 'har-format';
import type { SiteDescriptor, PageDescriptor } from '../types/site.js';
import { parsePage } from './dom-parser.js';
import { captureViewportScreenshot } from './screenshot-capture.js';
import { logger } from '../utils/logger.js';
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
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  const captureHar = options.captureHar ?? false;

  const pages: PageDescriptor[] = [];
  const screenshots = new Map<string, Buffer>();
  const harEntries: Entry[] = [];
  const pendingRequests = new Map<Request, { startTime: number }>();
  const visited = new Set<string>();
  const queue: Array<{ url: string; currentDepth: number }> = [
    { url: options.url, currentDepth: 0 },
  ];

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    // Optionally capture network requests as HAR entries during crawl
    if (captureHar) {
      page.on('request', (request) => {
        pendingRequests.set(request, { startTime: Date.now() });
      });
      page.on('response', async (response) => {
        const request = response.request();
        const pending = pendingRequests.get(request);
        if (!pending) return;
        pendingRequests.delete(request);
        try {
          const entry = await buildCrawlHarEntry(request, response, pending.startTime);
          harEntries.push(entry);
        } catch {
          // Some responses can't be read (redirects, aborted)
        }
      });
    }

    logger.info(`Crawling site: ${options.url} (depth: ${depth}, max pages: ${maxPages})`);
    let lastActivityTime = Date.now();

    while (queue.length > 0 && pages.length < maxPages) {
      const item = queue.shift()!;
      const normalizedUrl = normalizeUrl(item.url);

      // Skip if already visited or different origin
      if (visited.has(normalizedUrl)) continue;
      if (!item.url.startsWith(baseUrl)) continue;

      visited.add(normalizedUrl);

      // Check idle timeout
      if (Date.now() - lastActivityTime > timeout) {
        logger.warn('Idle timeout reached during crawl');
        break;
      }

      try {
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

        // Queue navigation links for further crawling
        if (item.currentDepth < depth) {
          for (const link of pageDescriptor.links) {
            if (link.isNavigation && !visited.has(normalizeUrl(link.href))) {
              queue.push({ url: link.href, currentDepth: item.currentDepth + 1 });
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

  let responseText: string | undefined;
  const responseMimeType = response.headers()['content-type'] ?? '';
  const skipBody = SKIP_BODY_MIME_TYPES.some((m) => responseMimeType.startsWith(m));
  const contentLength = parseInt(response.headers()['content-length'] ?? '0', 10);

  if (!skipBody && contentLength <= MAX_RESPONSE_BODY_BYTES) {
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
