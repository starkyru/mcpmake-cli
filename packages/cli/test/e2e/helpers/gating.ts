/**
 * Env gates for the e2e tiers. The whole suite is opt-in (`MCPMAKE_E2E=1`) so
 * the fast unit tier never pays for spawning the bin; heavier tiers add their
 * own flags so PR CI can stay net-free and quick while nightly/dispatch runs
 * the expensive paths.
 *
 * Usage: `describe.skipIf(!E2E)('…', () => { … })`.
 */

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

/** Master switch — nothing in the e2e suite runs without it. */
export const E2E = truthy(process.env.MCPMAKE_E2E);

/** Browser/Playwright crawl tests (Sprint E7). */
export const E2E_BROWSER = truthy(process.env.MCPMAKE_E2E_BROWSER);

/** Heavy tests: real `npm install`/build/run + MCP handshake (Sprint E6 Tier-B). */
export const E2E_HEAVY = truthy(process.env.MCPMAKE_E2E_HEAVY);
