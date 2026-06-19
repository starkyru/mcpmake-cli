import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHarFile } from '../../src/parser/har-loader.js';
import { filterHarEntries } from '../../src/parser/har-filter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

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

  it('respects domain filter', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries, {
      allowedDomains: ['api.example.com'],
    });
    expect(filtered.every((e) => e.request.url.includes('api.example.com'))).toBe(true);
  });
});
