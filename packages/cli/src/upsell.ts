import { type ArgsDef, type CommandContext, type CommandDef } from 'citty';
import { fetchPricing, formatPrice, logger } from '@mcpmake/core';

/** Canonical public pricing page (anchor section on the landing page). */
const PRICING_PAGE = 'https://mcpmake.dev/#pricing';

/** Short timeout: the footer must not add perceptible latency to a command. */
const UPSELL_TIMEOUT_MS = 1_500;

/**
 * Print a one-line pricing CTA after a successful generate/publish. Deliberately
 * quiet and best-effort:
 *   - skipped entirely in non-interactive shells (no TTY), in CI, or when
 *     `MCPMAKE_NO_UPSELL` is set — so it never pollutes pipes/logs or makes a
 *     network call where no human will see it;
 *   - any error (including a slow or unreachable backend) is swallowed so it can
 *     never change the outcome of the command it follows.
 *
 * Prices come from {@link fetchPricing}, which returns the bundled copy when the
 * backend is unreachable, so the line is always accurate-as-of-this-build.
 */
export async function printUpsellFooter(): Promise<void> {
  try {
    if (process.env.MCPMAKE_NO_UPSELL) return;
    if (!process.stdout.isTTY || process.env.CI) return;

    const { pricing } = await fetchPricing(undefined, UPSELL_TIMEOUT_MS);
    const sync = pricing.syncSolo;
    if (!sync) return;

    logger.info('');
    logger.info(
      `Tip: keep this server in sync with its API automatically — Sync ${formatPrice(sync)}.`,
    );
    logger.info(
      `See all plans with \`mcpmake pricing\`. Prices subject to change: ${PRICING_PAGE}`,
    );
  } catch {
    // An upsell line must never break a generate/publish.
  }
}

/**
 * Wrap a command so the pricing footer prints after a *successful* run. Failures
 * exit via `fail()` (which calls `process.exit`) before the wrapped run resolves,
 * and thrown errors propagate before the footer runs — so the footer only ever
 * follows success. Long-running modes (e.g. `--watch`) never resolve, so no
 * footer is printed mid-watch, which is intended.
 */
export function withUpsellFooter<T extends ArgsDef>(cmd: CommandDef<T>): CommandDef<T> {
  const run = cmd.run;
  return {
    ...cmd,
    run: async (ctx: CommandContext<T>) => {
      const result = run ? await run(ctx) : undefined;
      await printUpsellFooter();
      return result;
    },
  };
}
