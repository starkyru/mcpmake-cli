import { describe, it, expect } from 'vitest';
import { parseIntFlag, isValidSiteDescriptorShape } from '../../src/commands/rescan.js';

describe('rescan parseIntFlag', () => {
  it('falls back to the descriptor-derived default when the flag is unset', () => {
    expect(parseIntFlag(undefined, 'depth', 4)).toBe(4);
    expect(parseIntFlag('', 'max-pages', 12)).toBe(12);
  });

  it('parses a valid override', () => {
    expect(parseIntFlag('3', 'depth', 2)).toBe(3);
  });

  it('rejects non-numeric input rather than zeroing crawl scope', () => {
    expect(() => parseIntFlag('abc', 'max-pages', 12)).toThrow(/Invalid --max-pages/);
  });

  it('rejects negative input', () => {
    expect(() => parseIntFlag('-1', 'depth', 2)).toThrow(/Invalid --depth/);
  });
});

describe('rescan isValidSiteDescriptorShape', () => {
  const minimal = { pages: [], version: 1, baseUrl: 'https://example.com' };

  it('accepts a minimal valid shape', () => {
    expect(isValidSiteDescriptorShape(minimal)).toBe(true);
  });

  it('accepts a fully populated descriptor', () => {
    expect(
      isValidSiteDescriptorShape({ ...minimal, crawlDepth: 2, analyzedAt: '', metadata: {} }),
    ).toBe(true);
  });

  it('rejects an empty object — triggers the crash at pages.length', () => {
    expect(isValidSiteDescriptorShape({})).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidSiteDescriptorShape(null)).toBe(false);
  });

  it('rejects a non-object primitive', () => {
    expect(isValidSiteDescriptorShape('string')).toBe(false);
    expect(isValidSiteDescriptorShape(42)).toBe(false);
  });

  it('rejects when pages is missing — the TypeError path', () => {
    expect(isValidSiteDescriptorShape({ version: 1, baseUrl: 'https://example.com' })).toBe(false);
  });

  it('rejects when pages is not an array (e.g. hand-edited to a number)', () => {
    expect(isValidSiteDescriptorShape({ ...minimal, pages: 'bad' })).toBe(false);
    expect(isValidSiteDescriptorShape({ ...minimal, pages: null })).toBe(false);
  });

  it('rejects when version is missing — the NaN corruption path', () => {
    expect(isValidSiteDescriptorShape({ pages: [], baseUrl: 'https://example.com' })).toBe(false);
  });

  it('rejects when version is not a number (e.g. stringified)', () => {
    expect(isValidSiteDescriptorShape({ ...minimal, version: '1' })).toBe(false);
    expect(isValidSiteDescriptorShape({ ...minimal, version: null })).toBe(false);
  });

  it('rejects when baseUrl is missing — prevents crawlSite receiving undefined', () => {
    expect(isValidSiteDescriptorShape({ pages: [], version: 1 })).toBe(false);
  });

  it('rejects when baseUrl is not a string', () => {
    expect(isValidSiteDescriptorShape({ ...minimal, baseUrl: 42 })).toBe(false);
  });
});
