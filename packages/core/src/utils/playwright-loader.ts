/**
 * Lazy loader for the OPTIONAL `playwright` dependency.
 *
 * `playwright` is declared under `optionalDependencies`, so footprint-sensitive
 * users (OpenAPI / HAR / Postman only) can install with `--omit=optional` and
 * skip the heavy browser download. Browser-driven features (recorder, site
 * crawl, goal crawl, rescan healing) load `chromium` through this util so that,
 * when playwright is absent, they fail with a clear, actionable error instead of
 * a raw "Cannot find module 'playwright'" crash.
 *
 * The `import type` below is erased at compile time — it produces no runtime
 * `require`, so merely importing this module never pulls in playwright.
 */
import type { BrowserType } from 'playwright';

let cached: BrowserType | undefined;

/**
 * Resolve the playwright `chromium` browser launcher, loading the optional
 * `playwright` dependency on first use. Throws an actionable error when it is
 * not installed.
 */
export async function loadChromium(): Promise<BrowserType> {
  if (cached) return cached;
  try {
    const pw = await import('playwright');
    cached = pw.chromium;
    return cached;
  } catch {
    throw new Error(
      'Browser features require the optional "playwright" dependency, which is not installed. ' +
        'Install it with `npm install playwright` then `npx playwright install chromium`, ' +
        'or re-install without `--omit=optional`.',
    );
  }
}
