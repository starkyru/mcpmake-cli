import { describe, it, expect } from 'vitest';
import { deduplicateEntries } from '../../src/transformer/har-dedup.js';
import { normalizeEntry } from '../../src/parser/har-normalizer.js';
import type { Entry } from 'har-format';

function makeEntry(url: string, method = 'GET', time = '2024-01-01T00:00:00.000Z'): Entry {
  return {
    startedDateTime: time,
    time: 100,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: [],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [],
      cookies: [],
      content: { size: 0, mimeType: 'application/json' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 1, wait: 50, receive: 10 },
  };
}

describe('har-dedup', () => {
  it('removes retry requests within 5 seconds', () => {
    const entries = [
      normalizeEntry(makeEntry('https://api.test.com/items', 'GET', '2024-01-01T00:00:00.000Z')),
      normalizeEntry(makeEntry('https://api.test.com/items', 'GET', '2024-01-01T00:00:01.000Z')),
      normalizeEntry(makeEntry('https://api.test.com/items', 'GET', '2024-01-01T00:00:02.000Z')),
    ];
    const result = deduplicateEntries(entries);
    expect(result).toHaveLength(1);
  });

  it('keeps requests spaced more than 5 seconds apart', () => {
    const entries = [
      normalizeEntry(makeEntry('https://api.test.com/items', 'GET', '2024-01-01T00:00:00.000Z')),
      normalizeEntry(makeEntry('https://api.test.com/items', 'GET', '2024-01-01T00:00:10.000Z')),
    ];
    const result = deduplicateEntries(entries);
    expect(result).toHaveLength(2);
  });

  it('deduplicates pagination variants', () => {
    const entries = [
      normalizeEntry(
        makeEntry('https://api.test.com/items?page=1', 'GET', '2024-01-01T00:00:00.000Z'),
      ),
      normalizeEntry(
        makeEntry('https://api.test.com/items?page=2', 'GET', '2024-01-01T00:00:10.000Z'),
      ),
      normalizeEntry(
        makeEntry('https://api.test.com/items?page=3', 'GET', '2024-01-01T00:00:20.000Z'),
      ),
      normalizeEntry(
        makeEntry('https://api.test.com/items?page=4', 'GET', '2024-01-01T00:00:30.000Z'),
      ),
      normalizeEntry(
        makeEntry('https://api.test.com/items?page=5', 'GET', '2024-01-01T00:00:40.000Z'),
      ),
    ];
    // Add query strings
    for (let i = 0; i < entries.length; i++) {
      entries[i].entry.request.queryString = [{ name: 'page', value: String(i + 1) }];
    }
    const result = deduplicateEntries(entries);
    expect(result.length).toBeLessThan(entries.length);
  });

  it('keeps different endpoints', () => {
    const entries = [
      normalizeEntry(makeEntry('https://api.test.com/items', 'GET')),
      normalizeEntry(makeEntry('https://api.test.com/users', 'GET')),
    ];
    const result = deduplicateEntries(entries);
    expect(result).toHaveLength(2);
  });

  it('isPaginationVariant uses only the url — allEntries and current params removed (R3-6)', () => {
    // Regression: the old signature accepted (url, allEntries, current) but both
    // extra params were unused. Confirm deduplication works correctly now that the
    // call site passes only the url.
    const t0 = '2024-01-01T00:00:00.000Z';
    const t10 = '2024-01-01T00:00:10.000Z';
    const t20 = '2024-01-01T00:00:20.000Z';
    const t30 = '2024-01-01T00:00:30.000Z';
    const entries = [
      normalizeEntry(makeEntry('https://api.test.com/items?cursor=a', 'GET', t0)),
      normalizeEntry(makeEntry('https://api.test.com/items?cursor=b', 'GET', t10)),
      normalizeEntry(makeEntry('https://api.test.com/items?cursor=c', 'GET', t20)),
      normalizeEntry(makeEntry('https://api.test.com/items?cursor=d', 'GET', t30)),
    ];
    const result = deduplicateEntries(entries);
    // First 3 are kept (seen.count < 3 threshold), 4th is dropped.
    expect(result.length).toBeLessThan(entries.length);
  });
});
