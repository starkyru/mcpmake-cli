import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, truncate } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPostmanCollection } from '../../src/parser/postman-loader.js';

describe('postman-loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-postman-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects an oversized collection before parsing (DoS-lite cap)', async () => {
    const bigPath = resolve(tempDir, 'big.json');
    await writeFile(bigPath, '{}');
    // Sparse file: reports >50 MB to stat without consuming disk.
    await truncate(bigPath, 51 * 1024 * 1024);
    await expect(loadPostmanCollection(bigPath)).rejects.toThrow(/too large/);
  });

  it('loads a Postman collection and converts to HAR entries', async () => {
    const collection = {
      info: {
        name: 'Test API',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'List Users',
          request: {
            method: 'GET',
            url: {
              raw: 'https://api.test.com/users',
              protocol: 'https',
              host: ['api', 'test', 'com'],
              path: ['users'],
            },
            header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
          },
        },
        {
          name: 'Create User',
          request: {
            method: 'POST',
            url: 'https://api.test.com/users',
            header: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'Authorization', value: 'Bearer {{token}}' },
            ],
            body: { mode: 'raw', raw: '{"name": "Alice"}' },
          },
        },
      ],
      variable: [{ key: 'token', value: 'test-token-123' }],
    };

    const filePath = resolve(tempDir, 'collection.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries, collectionName } = await loadPostmanCollection(filePath);
    expect(collectionName).toBe('Test API');
    expect(entries).toHaveLength(2);
    expect(entries[0].request.method).toBe('GET');
    expect(entries[0].request.url).toContain('api.test.com/users');
    expect(entries[1].request.method).toBe('POST');
  });

  it('resolves variables in URLs and headers', async () => {
    const collection = {
      info: { name: 'Var Test', schema: '' },
      item: [
        {
          name: 'Test',
          request: {
            method: 'GET',
            url: 'https://{{host}}/api/v1/items',
            header: [{ key: 'X-API-Key', value: '{{apiKey}}' }],
          },
        },
      ],
      variable: [
        { key: 'host', value: 'api.example.com' },
        { key: 'apiKey', value: 'secret-key' },
      ],
    };

    const filePath = resolve(tempDir, 'vars.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries[0].request.url).toContain('api.example.com');
    expect(entries[0].request.headers.find((h) => h.name === 'X-API-Key')?.value).toBe(
      'secret-key',
    );
  });

  it('handles nested folders', async () => {
    const collection = {
      info: { name: 'Nested', schema: '' },
      item: [
        {
          name: 'Folder',
          item: [{ name: 'Inner', request: { method: 'GET', url: 'https://api.test.com/inner' } }],
        },
        { name: 'Top', request: { method: 'GET', url: 'https://api.test.com/top' } },
      ],
    };

    const filePath = resolve(tempDir, 'nested.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // A4-3: Unbounded recursion in flattenItems
  // -------------------------------------------------------------------------
  it('A4-3: throws a bounded error for collections nested deeper than 100 levels', async () => {
    // Build a >100-deep folder chain programmatically.
    type ItemNode = { name: string; item?: ItemNode[] };
    let inner: ItemNode = { name: 'leaf', item: [{ name: 'req' }] };
    for (let i = 101; i >= 0; i--) {
      inner = { name: `folder-${i}`, item: [inner] };
    }

    const collection = {
      info: { name: 'DeepNest', schema: '' },
      item: [inner],
    };

    const filePath = resolve(tempDir, 'deep.json');
    await writeFile(filePath, JSON.stringify(collection));

    await expect(loadPostmanCollection(filePath)).rejects.toThrow(
      'Postman collection nesting too deep (> 100 levels)',
    );
  });

  it('A4-3: does not throw for collections nested exactly at the 100-level boundary', async () => {
    // 100 levels of nesting is still allowed; only > 100 triggers the guard.
    type ItemNode = { name: string; item?: ItemNode[]; request?: { method: string; url: string } };
    let inner: ItemNode = {
      name: 'leaf',
      request: { method: 'GET', url: 'https://api.test.com/ok' },
    };
    for (let i = 99; i >= 0; i--) {
      inner = { name: `folder-${i}`, item: [inner] };
    }

    const collection = {
      info: { name: 'BoundaryNest', schema: '' },
      item: [inner],
    };

    const filePath = resolve(tempDir, 'boundary.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.url).toContain('api.test.com/ok');
  });

  // -------------------------------------------------------------------------
  // R22-3: non-array `item` field must not crash flattenItems
  // -------------------------------------------------------------------------
  it('R22-3: top-level item: {} (non-array object) returns empty entries without throwing', async () => {
    const collection = {
      info: { name: 'BadItem', schema: '' },
      // TypeScript types say PostmanItem[], but untrusted JSON may send an object
      item: {} as unknown,
    };

    const filePath = resolve(tempDir, 'bad-item.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries, collectionName } = await loadPostmanCollection(filePath);
    expect(collectionName).toBe('BadItem');
    expect(entries).toHaveLength(0);
  });

  it('R22-3: nested item: {} inside a folder is skipped without crashing, sibling requests still load', async () => {
    const collection = {
      info: { name: 'NestedBadItem', schema: '' },
      item: [
        {
          name: 'BadFolder',
          // non-array nested item — flattenItems must guard the recursive call
          item: {} as unknown,
        },
        {
          name: 'GoodRequest',
          request: { method: 'GET', url: 'https://api.test.com/good' },
        },
      ],
    };

    const filePath = resolve(tempDir, 'nested-bad-item.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.url).toContain('api.test.com/good');
  });

  // -------------------------------------------------------------------------
  // R22-4: object-url with empty host must not crash resolveUrl
  // -------------------------------------------------------------------------
  it('R22-4: object url with host: [] (empty array) skips that entry without throwing, valid sibling loads', async () => {
    const collection = {
      info: { name: 'EmptyHost', schema: '' },
      item: [
        {
          name: 'BadHostItem',
          request: {
            method: 'GET',
            // host: [] → joined string is "" → should be treated as localhost
            // but protocol+path may still form a parseable URL; primary test is no crash
            url: { protocol: 'not a valid protocol!!', host: [], path: ['api'] },
          },
        },
        {
          name: 'GoodItem',
          request: {
            method: 'GET',
            url: 'https://api.test.com/users',
          },
        },
      ],
    };

    const filePath = resolve(tempDir, 'empty-host.json');
    await writeFile(filePath, JSON.stringify(collection));

    // Must not throw — bad entry is skipped, good entry still loads
    const { entries } = await loadPostmanCollection(filePath);
    expect(entries.some((e) => e.request.url.includes('api.test.com/users'))).toBe(true);
  });

  it('R22-4: object url with host: [] falls back to localhost when protocol is valid', async () => {
    const collection = {
      info: { name: 'LocalhostFallback', schema: '' },
      item: [
        {
          name: 'EmptyHostItem',
          request: {
            method: 'GET',
            // host: [] with valid protocol — must use localhost fallback
            url: { protocol: 'https', host: [], path: ['health'] },
          },
        },
      ],
    };

    const filePath = resolve(tempDir, 'localhost-fallback.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.url).toContain('localhost');
  });
});
