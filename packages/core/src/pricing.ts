/**
 * Canonical pricing for mcpmake's lead commercial offering ("Family A").
 *
 * Family A is the *non-cloud* product: the local compiler (CLI), the CI sync
 * subscription, the self-hosted license, and done-for-you migration services.
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
    summary: 'CI drift-check + spec-currency auto-PRs, 1 repo.',
  },
  syncTeam: {
    id: 'sync-team',
    name: 'Sync — Team',
    priceUsd: 499,
    priceMaxUsd: null,
    period: 'monthly',
    summary: 'Multi-repo CI sync, policy checks, support.',
  },
  selfHostLicense: {
    id: 'self-host-license',
    name: 'Self-hosted license',
    priceUsd: 8_000,
    priceMaxUsd: 40_000,
    period: 'yearly',
    summary: 'Run the generator + sync on your own infra; governance + support SLA.',
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
 * @param serverUrl Backend base URL (defaults to {@link DEFAULT_PRICING_SERVER}).
 * @param timeoutMs Abort the request after this long (default 4000 ms).
 */
export async function fetchPricing(
  serverUrl: string = DEFAULT_PRICING_SERVER,
  timeoutMs = 4_000,
): Promise<{ pricing: Record<string, PricePoint>; source: 'backend' | 'bundled' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = serverUrl.replace(/\/+$/, '');
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
