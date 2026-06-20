import { describe, it, expect, vi } from 'vitest';
import { navigationHopDecision, isSameOrigin } from '../../src/analyzer/dom-parser.js';

/**
 * C1: per-hop SSRF interception for the Playwright crawlers.
 *
 * The crawlers install a `page.route('**\/*')` interceptor whose decision is the
 * pure `navigationHopDecision` helper. These tests pin that decision (which is
 * what the route handler calls) and exercise a faithful fake of the route
 * handler to prove it aborts cross-origin navigations and continues everything
 * else — without needing a real browser.
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
});

/** A minimal stand-in for the Playwright route/request the handler receives. */
function fakeRoute(url: string, isNavigationRequest: boolean) {
  const abort = vi.fn();
  const cont = vi.fn();
  return {
    request: () => ({ url: () => url, isNavigationRequest: () => isNavigationRequest }),
    abort,
    continue: cont,
  };
}

/**
 * Faithful copy of the route handler installed in goal-crawler / site-crawler.
 * If those handlers change, this should change in lockstep — it exists to prove
 * the wiring (abort vs continue) is correct against the same decision helper.
 */
function routeHandler(baseOrigin: string) {
  return (route: ReturnType<typeof fakeRoute>) => {
    const request = route.request();
    const decision = navigationHopDecision(
      request.isNavigationRequest(),
      request.url(),
      baseOrigin,
    );
    if (decision === 'abort') return route.abort('blockedbyclient');
    return route.continue();
  };
}

describe('C1: route handler aborts cross-origin nav, continues same-origin', () => {
  const baseOrigin = 'https://example.com';
  const handler = routeHandler(baseOrigin);

  it('aborts a cross-origin navigation request', () => {
    const route = fakeRoute('http://169.254.169.254/', true);
    handler(route);
    expect(route.abort).toHaveBeenCalledOnce();
    expect(route.continue).not.toHaveBeenCalled();
  });

  it('continues a same-origin navigation request', () => {
    const route = fakeRoute('https://example.com/next', true);
    handler(route);
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it('continues a cross-origin subresource (non-navigation) request', () => {
    const route = fakeRoute('https://cdn.other.test/lib.js', false);
    handler(route);
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
  });
});

/**
 * Pins the goal-crawler's pre-navigation gate: a link the LLM picks is checked
 * with isSameOrigin against the base origin before any page.goto is issued.
 * This is the decision the crawler makes at goal-crawler.ts before navigating
 * to chosenLink.href.
 */
describe('C1: goal-crawler refuses cross-origin LLM-chosen links pre-navigation', () => {
  const baseOrigin = 'https://shop.example.com';

  it('would navigate only for same-origin chosen links', () => {
    expect(isSameOrigin('https://shop.example.com/cart', baseOrigin)).toBe(true);
  });

  it('refuses (no navigation) for a cross-origin / internal chosen link', () => {
    expect(isSameOrigin('http://169.254.169.254/latest/meta-data', baseOrigin)).toBe(false);
    expect(isSameOrigin('https://evil.test/exfil', baseOrigin)).toBe(false);
    expect(isSameOrigin('https://shop.example.com.evil.test/', baseOrigin)).toBe(false);
  });
});
