import type { Browser, Request, Response } from 'playwright';
import type { Entry, Header } from 'har-format';
import { redactEntrySecrets } from '../parser/har-filter.js';
import { logger } from '../utils/logger.js';
import { assertPublicUrl, resolvePublicUrl } from '../utils/ssrf-guard.js';
import { startPinnedBrowserProxy, type PinnedBrowserProxy } from '../utils/pinned-browser-proxy.js';
import { loadChromium } from '../utils/playwright-loader.js';

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
// Defense-in-depth bound on the in-flight request map so a flood of requests
// that never resolve can't grow it without limit between cleanups.
const MAX_PENDING = 10_000;
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
  // SSRF guard: refuse private/loopback/link-local/metadata start hosts before
  // we launch a browser at them. Resolves DNS and enforces protocol + host.
  const seedResolution = await resolvePublicUrl(options.url);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  const headless = options.headless ?? false;

  let browser: Browser | undefined;
  let proxy: PinnedBrowserProxy | undefined;

  try {
    const chromium = await loadChromium();
    proxy = await startPinnedBrowserProxy(seedResolution);
    browser = await chromium.launch({
      headless,
      proxy: { server: proxy.server },
      args: ['--proxy-bypass-list=<-loopback>', '--disable-quic'],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Capture requests
    const onRequest = (request: Request) => {
      lastActivityTime = Date.now();
      // Drop the oldest pending entry if we ever hit the bound so a storm of
      // never-resolving requests can't grow the map without limit.
      if (pendingRequests.size >= MAX_PENDING) {
        const oldest = pendingRequests.keys().next().value;
        if (oldest) pendingRequests.delete(oldest);
      }
      pendingRequests.set(request, { startTime: Date.now() });
    };

    // Capture responses
    const onResponse = async (response: Response) => {
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
    };

    // A request can end WITHOUT ever firing 'response' (aborted, blocked,
    // failed DNS/TLS, or finished as a redirect). Free its pending entry on
    // both terminal events so the map can't leak across a long session.
    const onSettled = (request: Request) => {
      pendingRequests.delete(request);
    };

    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfailed', onSettled);
    page.on('requestfinished', onSettled);

    // Remove our listeners when the browser goes away so nothing is retained
    // past the session (the listeners close over entries/pendingRequests).
    browser.on('disconnected', () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onSettled);
      page.off('requestfinished', onSettled);
      pendingRequests.clear();
    });

    if (headless) {
      // Non-interactive capture: load the page, then auto-visit any extra
      // same-origin URLs, capturing their API traffic. No window to close.
      logger.info(`Capturing (headless) from: ${options.url}`);
      await page.goto(options.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});

      const navTargets = resolveNavTargets(options.navigate ?? [], baseUrl);
      for (const navUrl of navTargets) {
        // SSRF guard: a same-origin navigate target can still resolve to a
        // private/internal address. Resolve and refuse before navigating.
        try {
          await assertPublicUrl(navUrl);
        } catch (err) {
          logger.warn(
            `Skipping navigate target (SSRF guard): ${navUrl} — ${err instanceof Error ? err.message : err}`,
          );
          continue;
        }
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
    await proxy.close().catch(() => {});
    proxy = undefined;
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    if (proxy) await proxy.close().catch(() => {});
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

  // Scrub credentials at the recorder boundary too, so the entry never holds
  // a live secret even if it is persisted without going through filterHarEntries.
  return redactEntrySecrets({
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
  });
}
