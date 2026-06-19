import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHarFile } from '../../src/parser/har-loader.js';
import { filterHarEntries } from '../../src/parser/har-filter.js';
import { normalizeEntry } from '../../src/parser/har-normalizer.js';
import { clusterEntries } from '../../src/transformer/har-clusterer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

describe('har-clusterer', () => {
  it('clusters entries by method + normalized path', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries);
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);

    const signatures = clusters.map((c) => c.signature);
    expect(signatures).toContain('GET /v1/users');
    expect(signatures).toContain('POST /v1/users');
    expect(signatures).toContain('DELETE /v1/users/{userId}');
  });

  it('groups same-path entries into one cluster', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries);
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);

    // GET /v1/users/{userId} should group numeric + UUID entries
    const getUserCluster = clusters.find((c) => c.signature === 'GET /v1/users/{userId}');
    expect(getUserCluster).toBeDefined();
    expect(getUserCluster!.entries.length).toBe(2); // 42 and the UUID
  });

  it('sets correct method and path', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries);
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);

    const postCluster = clusters.find((c) => c.method === 'post');
    expect(postCluster).toBeDefined();
    expect(postCluster!.normalizedPath).toBe('/v1/users');
  });
});
