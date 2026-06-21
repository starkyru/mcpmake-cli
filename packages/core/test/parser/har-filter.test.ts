import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entry } from 'har-format';
import { loadHarFile } from '../../src/parser/har-loader.js';
import { filterHarEntries } from '../../src/parser/har-filter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

/**
 * A foreign-domain entry that passes EVERY filter except the domain allowlist:
 * non-noise pathname, not an analytics host, 200 status, application/json body.
 * Used to make the allowlist branch actually discriminating — without it the
 * only non-api.example.com URL in the fixture (google-analytics) is already
 * dropped by the analytics/image checks, so the allowlist would be a no-op.
 */
function foreignKeepableEntry(): Entry {
  return {
    startedDateTime: '2024-01-01T00:00:07.000Z',
    time: 100,
    request: {
      method: 'GET',
      url: 'https://other.com/api/widgets',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Accept', value: 'application/json' }],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      cookies: [],
      content: { size: 20, mimeType: 'application/json', text: '{"id": 1}' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 20,
    },
    cache: {},
    timings: { send: 1, wait: 50, receive: 10 },
  } as Entry;
}

describe('har-filter', () => {
  it('filters out favicon requests', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries);
    const urls = filtered.map((e) => e.request.url);
    expect(urls.some((u) => u.includes('favicon'))).toBe(false);
  });

  it('filters out analytics requests', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries);
    const urls = filtered.map((e) => e.request.url);
    expect(urls.some((u) => u.includes('google-analytics'))).toBe(false);
  });

  it('keeps API requests', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries);
    // Should keep: GET /users, GET /users/42, POST /users, DELETE /users/42, GET /users/uuid
    expect(filtered.length).toBe(5);
  });

  const API_URLS = [
    'https://api.example.com/v1/users',
    'https://api.example.com/v1/users/42',
    'https://api.example.com/v1/users',
    'https://api.example.com/v1/users/42',
    'https://api.example.com/v1/users/550e8400-e29b-41d4-a716-446655440000',
  ];
  const FOREIGN_URL = 'https://other.com/api/widgets';

  it('keeps a foreign-domain entry when no allowlist is given', async () => {
    // Positive companion: proves the synthetic entry survives ALL other filters,
    // so its later exclusion can only be attributed to the domain allowlist.
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const entries = [...har.log.entries, foreignKeepableEntry()];

    const filtered = filterHarEntries(entries);
    const urls = filtered.map((e) => e.request.url);

    expect(urls).toEqual([...API_URLS, FOREIGN_URL]);
  });

  it('respects domain filter', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    // Append a would-be-kept entry on a DIFFERENT domain. Without the allowlist
    // branch (har-filter.ts:167-170) this entry passes every other check and is
    // kept (see the companion test above), so its absence here is the discriminator.
    const entries = [...har.log.entries, foreignKeepableEntry()];

    const filtered = filterHarEntries(entries, {
      allowedDomains: ['api.example.com'],
    });
    const urls = filtered.map((e) => e.request.url);

    // Exact kept set: only the api.example.com entries, foreign one dropped.
    expect(urls).toEqual(API_URLS);
    expect(urls).not.toContain(FOREIGN_URL);
  });
});
