import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FAMILY_A_PRICING,
  formatPrice,
  fetchPricing,
  DEFAULT_PRICING_SERVER,
} from '../src/pricing.js';

describe('formatPrice', () => {
  it('renders free, monthly, yearly-banded, and one-off-banded labels', () => {
    expect(formatPrice(FAMILY_A_PRICING.cli)).toBe('Free forever');
    expect(formatPrice(FAMILY_A_PRICING.syncSolo)).toBe('$19/mo');
    expect(formatPrice(FAMILY_A_PRICING.syncTeam)).toBe('$499/mo');
    expect(formatPrice(FAMILY_A_PRICING.enterpriseSupport)).toBe('from $8,000/yr');
    expect(formatPrice(FAMILY_A_PRICING.migration)).toBe('$5,000–$20,000 one-off');
  });
});

describe('bundled pricing copy — shipped-truth guard', () => {
  // The bundled FAMILY_A_PRICING is printed offline by the CLI and can be served by the cloud
  // via /api/pricing, so its summaries must not advertise capabilities that don't ship. The
  // only shipped "Sync" mechanism is the self-hosted `mcpmake ci init [--pr]` workflow — there
  // is no managed centralized multi-repo sync service and no policy-check engine. This test
  // blocks that phrasing from silently returning to the copy.
  const UNSHIPPED = [/policy\s*check/i, /multi[-\s]?repo/i, /centralized sync/i];

  it('no Family A summary advertises an unshipped Sync capability', () => {
    for (const [key, point] of Object.entries(FAMILY_A_PRICING)) {
      for (const banned of UNSHIPPED) {
        expect(
          banned.test(point.summary),
          `pricing "${key}" summary contains unshipped phrasing (${banned}): "${point.summary}"`,
        ).toBe(false);
      }
    }
  });
});

describe('fetchPricing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns backend pricing on a well-formed response', async () => {
    const payload = { familyA: { cli: FAMILY_A_PRICING.cli } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );
    const { pricing, source } = await fetchPricing('https://example.test');
    expect(source).toBe('backend');
    expect(pricing.cli.priceUsd).toBe(0);
  });

  it('falls back to bundled pricing on a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const { pricing, source } = await fetchPricing('https://example.test');
    expect(source).toBe('bundled');
    expect(pricing).toBe(FAMILY_A_PRICING);
  });

  it('falls back to bundled pricing on a malformed payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ familyA: { bad: { id: 1 } } }), { status: 200 }),
      ),
    );
    const { source } = await fetchPricing('https://example.test');
    expect(source).toBe('bundled');
  });

  it('falls back to bundled pricing when the request throws (offline)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { pricing, source } = await fetchPricing('https://example.test');
    expect(source).toBe('bundled');
    expect(pricing).toBe(FAMILY_A_PRICING);
  });

  it('honors $MCPMAKE_SERVER (trailing slash trimmed) when no URL is passed', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ familyA: { cli: FAMILY_A_PRICING.cli } }), {
          status: 200,
        });
      }),
    );
    const prev = process.env.MCPMAKE_SERVER;
    process.env.MCPMAKE_SERVER = 'https://staging.example.test/';
    try {
      const { source } = await fetchPricing();
      expect(source).toBe('backend');
      expect(calls[0]).toBe('https://staging.example.test/api/pricing');
    } finally {
      if (prev === undefined) delete process.env.MCPMAKE_SERVER;
      else process.env.MCPMAKE_SERVER = prev;
    }
  });

  it('defaults to the production pricing server', () => {
    expect(DEFAULT_PRICING_SERVER).toBe('https://mcpmake.dev');
  });
});
