import { describe, it, expect, vi } from 'vitest';
import { navigationHopDecision, isSameOrigin } from '../../src/analyzer/dom-parser.js';
import { makeNavigationHopRouteHandler } from '../../src/analyzer/same-origin.js';

/**
 * C1: per-hop SSRF interception for the Playwright crawlers.
 *
 * Both crawlers install a `page.route('**\/*')` interceptor built by the shared
 * `makeNavigationHopRouteHandler` factory, whose decision is the pure
 * `navigationHopDecision` helper. These tests pin that decision AND exercise the
 * REAL factory (the same one wired into site-crawler / goal-crawler) against a
 * fake route/request — proving it aborts cross-origin navigations and continues
 * everything else, without needing a real browser.
 */
describe('C1: navigationHopDecision — per-hop SSRF gate', () => {
  const base = 'https://example.com';

  it('continues same-origin navigations/document loads', () => {
    expect(navigationHopDecision(true, 'https://example.com/page', base)).toBe('continue');
    expect(navigationHopDecision(true, 'https://example.com/a?x=1', base)).toBe('continue');
  });

  it('aborts cross-origin navigations (redirect-to-internal / off-origin links)', () => {
    expect(navigationHopDecision(true, 'http://169.254.169.254/latest/meta-data', base)).toBe(
      'abort',
    );
    expect(navigationHopDecision(true, 'http://localhost:8080/admin', base)).toBe('abort');
    // prefix-spoofing host must not slip through the origin equality check
    expect(navigationHopDecision(true, 'https://example.com.attacker.test/', base)).toBe('abort');
    // different scheme/port are different origins
    expect(navigationHopDecision(true, 'http://example.com/', base)).toBe('abort');
    expect(navigationHopDecision(true, 'https://example.com:8443/', base)).toBe('abort');
  });

  it('continues NON-navigation subresources regardless of origin (so pages render)', () => {
    // cross-origin subresource (e.g. a CDN script) is allowed — it cannot
    // pivot the top-level navigation context.
    expect(navigationHopDecision(false, 'https://cdn.other.test/app.js', base)).toBe('continue');
    expect(navigationHopDecision(false, 'https://example.com/style.css', base)).toBe('continue');
  });

  it('a cross-origin NON-navigation request never aborts even off-origin', () => {
    // Belt-and-braces: the navigation flag, not the origin, decides for
    // subresources. Inverting the early `if (!isNavigation) return 'continue'`
    // would turn this into 'abort' and break page rendering.
    expect(navigationHopDecision(false, 'http://169.254.169.254/x', base)).toBe('continue');
  });
});

/** A minimal stand-in for the Playwright route/request the handler receives. */
function fakeRoute(url: string, isNavigationRequest: boolean) {
  const abort = vi.fn(async () => {});
  const cont = vi.fn(async () => {});
  return {
    request: () => ({ url: () => url, isNavigationRequest: () => isNavigationRequest }),
    abort,
    continue: cont,
  };
}

/**
 * Drives the REAL route-handler factory used by both crawlers
 * (`makeNavigationHopRouteHandler` in same-origin.ts, installed verbatim at
 * site-crawler.ts and goal-crawler.ts via `page.route('**\/*', …)`). A
 * regression in that handler — flipping abort<->continue, dropping the
 * 'blockedbyclient' reason, or ignoring the navigation flag — fails these tests.
 */
describe('C1: route handler aborts cross-origin nav, continues same-origin', () => {
  const baseOrigin = 'https://example.com';
  // Cast: fakeRoute is a structural stand-in for Playwright's Route.
  const handler = makeNavigationHopRouteHandler(baseOrigin) as unknown as (
    route: ReturnType<typeof fakeRoute>,
  ) => Promise<void>;

  it('aborts a cross-origin navigation request with reason "blockedbyclient"', async () => {
    const route = fakeRoute('http://169.254.169.254/', true);
    await handler(route);
    expect(route.abort).toHaveBeenCalledOnce();
    // The abort reason is load-bearing (Chromium maps it to net::ERR_BLOCKED_BY_CLIENT).
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
  });

  it('aborts a prefix-spoofing cross-origin navigation (example.com.attacker.test)', async () => {
    const route = fakeRoute('https://example.com.attacker.test/steal', true);
    await handler(route);
    expect(route.abort).toHaveBeenCalledOnce();
    expect(route.continue).not.toHaveBeenCalled();
  });

  it('continues a same-origin navigation request', async () => {
    const route = fakeRoute('https://example.com/next', true);
    await handler(route);
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it('continues a cross-origin subresource (non-navigation) request', async () => {
    const route = fakeRoute('https://cdn.other.test/lib.js', false);
    await handler(route);
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it('continues even an internal-IP subresource (non-navigation) so it cannot deadlock rendering', async () => {
    const route = fakeRoute('http://169.254.169.254/x', false);
    await handler(route);
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
  });
});

/**
 * Pins the predicate behind the goal-crawler's pre-navigation gate.
 *
 * The real gate is `if (!isSameOrigin(chosenLink.href, baseOrigin)) break;`
 * (goal-crawler.ts) — driven before any page.goto for an LLM-chosen link. We
 * can't run the full LLM-driven crawl here without a browser, so we exercise the
 * exact predicate that decides it. The companion `gateDecision` mirrors the real
 * branch (`!isSameOrigin` -> 'refuse') so a logic inversion in either the
 * predicate or that branch's polarity would surface.
 */
describe('C1: isSameOrigin predicate behind goal-crawler pre-navigation gate', () => {
  const baseOrigin = 'https://shop.example.com';

  // Mirror of the real gate's branch: the crawler navigates only when the
  // chosen link is same-origin, and refuses (breaks the crawl) otherwise.
  const gateDecision = (href: string): 'navigate' | 'refuse' =>
    isSameOrigin(href, baseOrigin) ? 'navigate' : 'refuse';

  it('navigates for a same-origin chosen link', () => {
    expect(isSameOrigin('https://shop.example.com/cart', baseOrigin)).toBe(true);
    expect(gateDecision('https://shop.example.com/cart')).toBe('navigate');
    expect(gateDecision('https://shop.example.com/checkout?step=2')).toBe('navigate');
  });

  it('refuses (no navigation) for cross-origin / internal / prefix-spoof chosen links', () => {
    // cloud metadata endpoint
    expect(isSameOrigin('http://169.254.169.254/latest/meta-data', baseOrigin)).toBe(false);
    expect(gateDecision('http://169.254.169.254/latest/meta-data')).toBe('refuse');
    // unrelated external origin
    expect(gateDecision('https://evil.test/exfil')).toBe('refuse');
    // prefix-spoofing host that startsWith(base) would have wrongly admitted
    expect('https://shop.example.com.evil.test/'.startsWith(baseOrigin)).toBe(true);
    expect(gateDecision('https://shop.example.com.evil.test/')).toBe('refuse');
    // sibling subdomain is a different origin
    expect(gateDecision('https://admin.example.com/')).toBe('refuse');
    // non-navigable scheme whose URL.origin would otherwise spoof a match
    expect(gateDecision('blob:https://shop.example.com/abc')).toBe('refuse');
  });
});
