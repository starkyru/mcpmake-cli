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

  // Per-page validation — R22-1: a partial page element must be rejected so the
  // guard prevents the downstream TypeError in diffForms / diffButtons /
  // diffLinks / collectLowConfidenceSelectors.
  it('rejects a descriptor whose pages array contains an empty object (no url/pageId/forms/buttons/links)', () => {
    expect(isValidSiteDescriptorShape({ ...minimal, pages: [{}] })).toBe(false);
  });

  it('accepts a descriptor whose pages array contains a fully-valid page object', () => {
    const validPage = {
      url: 'https://example.com/',
      pageId: 'page-1',
      forms: [],
      buttons: [],
      links: [],
    };
    expect(isValidSiteDescriptorShape({ ...minimal, pages: [validPage] })).toBe(true);
  });

  it('rejects a page that has url and pageId but is missing the forms array', () => {
    const pageNoForms = {
      url: 'https://example.com/',
      pageId: 'page-1',
      buttons: [],
      links: [],
    };
    expect(isValidSiteDescriptorShape({ ...minimal, pages: [pageNoForms] })).toBe(false);
  });

  it('rejects a page missing pageId', () => {
    const pageNoId = { url: 'https://example.com/', forms: [], buttons: [], links: [] };
    expect(isValidSiteDescriptorShape({ ...minimal, pages: [pageNoId] })).toBe(false);
  });

  it('rejects a page missing url', () => {
    const pageNoUrl = { pageId: 'page-1', forms: [], buttons: [], links: [] };
    expect(isValidSiteDescriptorShape({ ...minimal, pages: [pageNoUrl] })).toBe(false);
  });

  it('rejects when pages contains a non-object element (e.g. null or a string)', () => {
    expect(isValidSiteDescriptorShape({ ...minimal, pages: [null] })).toBe(false);
    expect(isValidSiteDescriptorShape({ ...minimal, pages: ['bad'] })).toBe(false);
  });

  it('accepts a descriptor with multiple valid pages', () => {
    const makePage = (id: string, url: string) => ({
      url,
      pageId: id,
      forms: [],
      buttons: [],
      links: [],
    });
    expect(
      isValidSiteDescriptorShape({
        ...minimal,
        pages: [
          makePage('p1', 'https://example.com/'),
          makePage('p2', 'https://example.com/about'),
        ],
      }),
    ).toBe(true);
  });

  it('rejects when at least one page in a multi-page array is partial', () => {
    const good = { url: 'https://example.com/', pageId: 'p1', forms: [], buttons: [], links: [] };
    const bad = { url: 'https://example.com/about' }; // missing pageId, forms, buttons, links
    expect(isValidSiteDescriptorShape({ ...minimal, pages: [good, bad] })).toBe(false);
  });
});
