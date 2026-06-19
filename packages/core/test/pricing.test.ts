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
    expect(formatPrice(FAMILY_A_PRICING.selfHostLicense)).toBe('from $8,000/yr');
    expect(formatPrice(FAMILY_A_PRICING.migration)).toBe('$5,000–$20,000 one-off');
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

  it('defaults to the production pricing server', () => {
    expect(DEFAULT_PRICING_SERVER).toBe('https://mcpmake.dev');
  });
});
