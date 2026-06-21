/**
 * Shared per-hop SSRF route handler for the Playwright crawlers.
 *
 * Both {@link import('./site-crawler.js').crawlSite} and
 * {@link import('./goal-crawler.js').goalDirectedCrawl} install the same
 * `page.route('**\/*', …)` interceptor to gate cross-origin navigation hops.
 * Keeping a single factory here (rather than duplicating the handler in each
 * crawler) means the abort/continue wiring is defined — and tested — in exactly
 * one place. See {@link navigationHopDecision} for the underlying decision.
 */

import type { Route } from 'playwright';
import { navigationHopDecision } from './dom-parser.js';
import { logger } from '../utils/logger.js';

/**
 * Build the `page.route` handler that aborts cross-origin navigation/document
 * hops to `baseOrigin` and continues everything else (same-origin navigations
 * and all subresources). Cross-origin navigations are aborted with the
 * `'blockedbyclient'` reason and logged via {@link logger}.
 *
 * @param baseOrigin the crawl's base origin (from `new URL(start).origin`)
 */
export function makeNavigationHopRouteHandler(baseOrigin: string): (route: Route) => Promise<void> {
  return async (route: Route): Promise<void> => {
    const request = route.request();
    const decision = navigationHopDecision(
      request.isNavigationRequest(),
      request.url(),
      baseOrigin,
    );
    if (decision === 'abort') {
      logger.warn(`Blocked cross-origin navigation hop (SSRF guard): ${request.url()}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  };
}
