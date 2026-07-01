/**
 * Canonical pricing for mcpmake's lead commercial offering ("Family A").
 *
 * Family A is the *non-cloud* product: the local compiler (CLI), the CI sync
 * subscription, an enterprise support + indemnity plan, and done-for-you
 * migration services.
 *
 * Family B (managed cloud hosting) is a separate convenience add-on; its
 * limits and plan enforcement live in the hosting backend, not in this package.
 *
 * The numbers below are the bundled offline fallback; the live `/api/pricing`
 * backend is authoritative (see {@link fetchPricing}).
 */

export type BillingPeriod = 'monthly' | 'yearly' | 'one-off';

export interface PricePoint {
  /** Stable internal id. */
  id: string;
  /** Display name. */
  name: string;
  /** Entry price in whole USD. 0 = free. */
  priceUsd: number;
  /**
   * Upper bound for banded tiers (services/license priced by scope/support).
   * `null` for a fixed price.
   */
  priceMaxUsd: number | null;
  period: BillingPeriod;
  /** One-line description of what the tier delivers. */
  summary: string;
}

/** Family A — the lead, non-cloud offering. Source of truth for docs/UI. */
export const FAMILY_A_PRICING: Record<string, PricePoint> = {
  cli: {
    id: 'cli',
    name: 'Local compiler (CLI)',
    priceUsd: 0,
    priceMaxUsd: null,
    period: 'monthly',
    summary:
      'Generate editable code you own, run anywhere. Free forever.',
  },
  syncSolo: {
    id: 'sync-solo',
    name: 'Sync — Solo',
    priceUsd: 19,
    priceMaxUsd: null,
    period: 'monthly',
    summary: 'CI drift-check that fails the build on spec drift, 1 repo.',
  },
  syncTeam: {
    id: 'sync-team',
    name: 'Sync — Team',
    priceUsd: 499,
    priceMaxUsd: null,
    period: 'monthly',
    summary: 'CI drift-check with team seats and priority support.',
  },
  // NB: the CLI is Apache-2.0 — running the generator on your own infra is
  // already free, so this is NOT a code license. It sells the commercial
  // wrapper enterprises actually need around the OSS: a support SLA, IP
  // indemnity, and a vendor contract/MSA.
  enterpriseSupport: {
    id: 'enterprise-support',
    name: 'Enterprise Support & Indemnity',
    priceUsd: 8_000,
    priceMaxUsd: 40_000,
    period: 'yearly',
    summary:
      'Support SLA, IP indemnity + commercial contract around the OSS. On-prem platform licensed separately.',
  },
  migration: {
    id: 'migration',
    name: 'Migration engagement',
    priceUsd: 5_000,
    priceMaxUsd: 20_000,
    period: 'one-off',
    summary: 'Done-for-you API → owned MCP servers + CI wiring.',
  },
};

/** Default backend that serves the authoritative pricing. */
export const DEFAULT_PRICING_SERVER = 'https://mcpmake.dev';

function isPricePoint(v: unknown): v is PricePoint {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.priceUsd === 'number' &&
    (p.priceMaxUsd === null || typeof p.priceMaxUsd === 'number') &&
    (p.period === 'monthly' || p.period === 'yearly' || p.period === 'one-off') &&
    typeof p.summary === 'string'
  );
}

/**
 * Fetch the live Family A pricing from the backend so an outdated installed CLI
 * never prints stale numbers. Falls back to the bundled {@link FAMILY_A_PRICING}
 * when the backend is unreachable, slow, or returns anything unexpected — the
 * CLI must still work offline.
 *
 * Server precedence: an explicit `serverUrl` wins; otherwise the `MCPMAKE_SERVER`
 * env var (so the CLI can be pointed at a staging backend, matching the telemetry
 * reporter in `utils/fail.ts`); otherwise {@link DEFAULT_PRICING_SERVER}.
 *
 * @param serverUrl Backend base URL. Defaults to `$MCPMAKE_SERVER`, then {@link DEFAULT_PRICING_SERVER}.
 * @param timeoutMs Abort the request after this long (default 4000 ms).
 */
export async function fetchPricing(
  serverUrl?: string,
  timeoutMs = 4_000,
): Promise<{ pricing: Record<string, PricePoint>; source: 'backend' | 'bundled' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = (serverUrl ?? process.env.MCPMAKE_SERVER ?? DEFAULT_PRICING_SERVER).replace(
      /\/+$/,
      '',
    );
    const res = await fetch(`${base}/api/pricing`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { pricing: FAMILY_A_PRICING, source: 'bundled' };

    const body = (await res.json()) as { familyA?: unknown };
    const familyA = body?.familyA;
    if (typeof familyA !== 'object' || familyA === null) {
      return { pricing: FAMILY_A_PRICING, source: 'bundled' };
    }

    // Only accept a well-formed payload; one bad entry falls back wholesale so
    // we never mix live and stale prices in a single display.
    const entries = Object.entries(familyA as Record<string, unknown>);
    if (entries.length === 0 || !entries.every(([, v]) => isPricePoint(v))) {
      return { pricing: FAMILY_A_PRICING, source: 'bundled' };
    }
    return { pricing: familyA as Record<string, PricePoint>, source: 'backend' };
  } catch {
    return { pricing: FAMILY_A_PRICING, source: 'bundled' };
  } finally {
    clearTimeout(timer);
  }
}

const PERIOD_SUFFIX: Record<BillingPeriod, string> = {
  monthly: '/mo',
  yearly: '/yr',
  'one-off': ' one-off',
};

/**
 * Human-readable price label, e.g. `"Free forever"`, `"$19/mo"`,
 * `"from $8,000/yr"`, `"$5,000–$20,000 one-off"`.
 */
export function formatPrice(p: PricePoint): string {
  if (p.priceUsd === 0) return 'Free forever';
  const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
  const suffix = PERIOD_SUFFIX[p.period];
  if (p.priceMaxUsd != null) {
    return p.period === 'one-off'
      ? `${usd(p.priceUsd)}–${usd(p.priceMaxUsd)}${suffix}`
      : `from ${usd(p.priceUsd)}${suffix}`;
  }
  return `${usd(p.priceUsd)}${suffix}`;
}
