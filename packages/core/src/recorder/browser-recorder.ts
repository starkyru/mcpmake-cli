import { chromium } from 'playwright';
import type { Browser, Request, Response } from 'playwright';
import type { Entry, Header } from 'har-format';
import { logger } from '../utils/logger.js';

export interface RecorderOptions {
  url: string;
  timeout?: number; // idle timeout in ms (default: 5 minutes)
  /**
   * Run the browser headless and capture non-interactively (CI-friendly).
   * In this mode there is no window for a human to drive, so traffic is
   * captured from the initial load plus any `navigate` URLs, then the
   * browser closes automatically.
   */
  headless?: boolean;
  /**
   * Additional same-origin URLs (absolute or relative to `url`) to visit
   * automatically in headless mode to surface more API calls.
   */
  navigate?: string[];
}

export interface RecordingResult {
  entries: Entry[];
  baseUrl: string;
}

const MAX_ENTRIES = 10_000;
const MAX_RESPONSE_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const SKIP_BODY_MIME_TYPES = ['image/', 'video/', 'audio/', 'font/', 'application/octet-stream'];
// Playwright resource types that are large-by-nature; skip body capture for
// them at the header level rather than buffering and discarding afterwards.
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

export async function recordBrowserSession(options: RecorderOptions): Promise<RecordingResult> {
  const idleTimeout = options.timeout ?? 5 * 60 * 1000;
  const entries: Entry[] = [];
  const pendingRequests = new Map<Request, { startTime: number }>();
  let lastActivityTime = Date.now();

  const parsedUrl = new URL(options.url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  const headless = options.headless ?? false;

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Capture requests
    page.on('request', (request) => {
      lastActivityTime = Date.now();
      pendingRequests.set(request, { startTime: Date.now() });
    });

    // Capture responses
    page.on('response', async (response) => {
      lastActivityTime = Date.now();
      const request = response.request();
      const pending = pendingRequests.get(request);
      if (!pending) return;
      // Always free the pending entry, even when we drop this response below.
      // Returning before the delete (e.g. at the MAX_ENTRIES cap) leaks the
      // pendingRequests map across a long interactive session.
      try {
        if (entries.length >= MAX_ENTRIES) return;

        const entry = await buildHarEntry(request, response, pending.startTime);
        entries.push(entry);
        if (entries.length === MAX_ENTRIES) {
          logger.warn(`Captured ${MAX_ENTRIES} entries — ignoring further requests.`);
        }
      } catch {
        // Some responses can't be read (e.g., redirects, aborted)
      } finally {
        pendingRequests.delete(request);
      }
    });

    if (headless) {
      // Non-interactive capture: load the page, then auto-visit any extra
      // same-origin URLs, capturing their API traffic. No window to close.
      logger.info(`Capturing (headless) from: ${options.url}`);
      await page.goto(options.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});

      const navTargets = resolveNavTargets(options.navigate ?? [], baseUrl);
      for (const navUrl of navTargets) {
        logger.info(`  visiting: ${navUrl}`);
        try {
          await page.goto(navUrl, { waitUntil: 'networkidle', timeout: 30_000 });
        } catch {
          // Skip navigations that fail (timeout, 4xx, etc.)
        }
      }

      // Let any trailing XHRs settle before closing.
      await page.waitForTimeout(1000);
      await browser.close().catch(() => {});
      browser = undefined;
    } else {
      // Interactive capture: a human drives the visible window.
      logger.info(`Opening browser at: ${options.url}`);
      logger.info('Interact with the page to capture API calls.');
      logger.info('Close the browser window when done.');
      await page.goto(options.url, { waitUntil: 'domcontentloaded' });

      // Wait for the user to close the browser or idle timeout
      await new Promise<void>((resolve) => {
        const idleCheck = setInterval(() => {
          if (Date.now() - lastActivityTime > idleTimeout) {
            logger.warn(`Idle timeout (${Math.round(idleTimeout / 1000)}s). Closing browser.`);
            clearInterval(idleCheck);
            browser?.close().then(resolve).catch(resolve);
          }
        }, 5000);

        browser!.on('disconnected', () => {
          clearInterval(idleCheck);
          resolve();
        });
      });
    }
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    throw error;
  }

  return { entries, baseUrl };
}

/**
 * Resolve auto-navigation targets against the base URL, keeping only
 * same-origin http/https URLs (avoids wandering off to other hosts).
 */
function resolveNavTargets(navigate: string[], baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const out: string[] = [];
  for (const raw of navigate) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const resolved = new URL(trimmed, baseUrl);
      if (!['http:', 'https:'].includes(resolved.protocol)) continue;
      if (resolved.host !== base.host) {
        logger.warn(`Skipping cross-origin navigate target: ${trimmed}`);
        continue;
      }
      out.push(resolved.toString());
    } catch {
      logger.warn(`Skipping invalid navigate target: ${trimmed}`);
    }
  }
  return out;
}

async function buildHarEntry(
  request: Request,
  response: Response,
  startTime: number,
): Promise<Entry> {
  const elapsed = Date.now() - startTime;
  const url = request.url();
  const parsedUrl = new URL(url);

  // Request headers
  const requestHeaders: Header[] = Object.entries(request.headers()).map(([name, value]) => ({
    name,
    value,
  }));

  // Query string
  const queryString = [...parsedUrl.searchParams.entries()].map(([name, value]) => ({
    name,
    value,
  }));

  // Request body
  const postData = request.postData();
  const contentTypeHeader = request.headers()['content-type'] ?? '';

  // Response headers
  const responseHeaders: Header[] = Object.entries(response.headers()).map(([name, value]) => ({
    name,
    value,
  }));

  // Response body — skip large or binary responses BEFORE buffering. The cap
  // must be enforced at the header/resource-type level: once `response.body()`
  // resolves, Playwright has already buffered the whole response into memory,
  // so a post-hoc `body.length` check does nothing to protect us against a
  // missing/dishonest Content-Length. We therefore skip body capture for
  // large-by-type resources and for responses whose declared length exceeds
  // the cap, and only fall back to reading when the size is known and bounded.
  let responseText: string | undefined;
  const responseMimeType = response.headers()['content-type'] ?? '';
  const skipBody =
    SKIP_BODY_MIME_TYPES.some((m) => responseMimeType.startsWith(m)) ||
    SKIP_BODY_RESOURCE_TYPES.has(request.resourceType());
  const rawContentLength = response.headers()['content-length'];
  const parsedLength = rawContentLength === undefined ? NaN : parseInt(rawContentLength, 10);
  const lengthKnown = Number.isFinite(parsedLength) && parsedLength >= 0;
  const tooLargeByHeader = lengthKnown && parsedLength > MAX_RESPONSE_BODY_BYTES;

  // Only buffer when we won't blow the cap: either the declared length is known
  // and within the cap, or the length is unknown but the resource type is one
  // we expect to be small (text/json/xhr/fetch/document).
  if (!skipBody && !tooLargeByHeader) {
    try {
      const body = await response.body();
      // Backstop: a dishonest/absent Content-Length can still under-report, so
      // discard anything that turns out to exceed the cap after the fact.
      if (body.length <= MAX_RESPONSE_BODY_BYTES) {
        responseText = body.toString('utf-8');
      }
    } catch {
      // Body may not be available for some response types
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
