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

  // -------------------------------------------------------------------------
  // R23-B: null/non-object elements inside Postman arrays must not crash
  // -------------------------------------------------------------------------
  it('R23-B: item: [null] at top level is skipped; valid sibling still loads', async () => {
    const collection = {
      info: { name: 'NullItem', schema: '' },
      item: [
        null,
        { name: 'GoodRequest', request: { method: 'GET', url: 'https://api.test.com/ok' } },
      ] as unknown[],
    };

    const filePath = resolve(tempDir, 'null-item.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.url).toContain('api.test.com/ok');
  });

  it('R23-B: variable: [null] does not throw; remaining variables still resolve', async () => {
    const collection = {
      info: { name: 'NullVar', schema: '' },
      item: [
        {
          name: 'VarRequest',
          request: { method: 'GET', url: 'https://{{host}}/path' },
        },
      ],
      variable: [null, { key: 'host', value: 'api.example.com' }] as unknown[],
    };

    const filePath = resolve(tempDir, 'null-var.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.url).toContain('api.example.com');
  });

  it('R23-B: null element inside a nested folder item array is skipped; valid sibling inside the same folder loads', async () => {
    const collection = {
      info: { name: 'NullInFolder', schema: '' },
      item: [
        {
          name: 'Folder',
          item: [
            null,
            { name: 'Inner', request: { method: 'GET', url: 'https://api.test.com/inner' } },
          ] as unknown[],
        },
      ],
    };

    const filePath = resolve(tempDir, 'null-in-folder.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.url).toContain('api.test.com/inner');
  });

  it('R23-B: header: [null] does not throw; non-null headers are still mapped', async () => {
    const collection = {
      info: { name: 'NullHeader', schema: '' },
      item: [
        {
          name: 'HeaderRequest',
          request: {
            method: 'GET',
            url: 'https://api.test.com/ok',
            header: [null, { key: 'X-Foo', value: 'bar' }] as unknown[],
          },
        },
      ],
    };

    const filePath = resolve(tempDir, 'null-header.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.headers.find((h) => h.name === 'X-Foo')?.value).toBe('bar');
  });

  it('skips malformed header key/value entries without aborting valid siblings', async () => {
    const collection = {
      info: { name: 'MalformedHeader', schema: '' },
      item: [
        {
          name: 'HeaderRequest',
          request: {
            method: 'GET',
            url: 'https://api.test.com/ok',
            header: [
              { key: 'X-Null', value: null },
              { key: null, value: 'bad' },
              { key: 'X-Good', value: 'safe' },
            ] as unknown[],
          },
        },
      ],
    };

    const filePath = resolve(tempDir, 'malformed-header.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.headers).toEqual(
      expect.arrayContaining([{ name: 'X-Good', value: 'safe' }]),
    );
    expect(entries[0].request.headers).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Transitive variable resolution: a variable whose value contains another
  // {{var}} must be resolved through to the underlying value (bounded passes).
  // -------------------------------------------------------------------------
  it('resolves a variable whose value references another variable (transitive, 2 levels)', async () => {
    const collection = {
      info: { name: 'Transitive', schema: '' },
      item: [
        {
          name: 'Test',
          request: { method: 'GET', url: 'https://{{host}}/v1/items' },
        },
      ],
      variable: [
        // host -> {{env}}.example.com -> prod.example.com
        { key: 'host', value: '{{env}}.example.com' },
        { key: 'env', value: 'prod' },
      ],
    };

    const filePath = resolve(tempDir, 'transitive.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    // Fully resolved: no {{...}} left, host expanded to prod.example.com.
    expect(entries[0].request.url).toBe('https://prod.example.com/v1/items');
  });

  it('resolves a 3-level transitive chain ({{a}}->{{b}}->{{c}}->literal)', async () => {
    const collection = {
      info: { name: 'Chain', schema: '' },
      item: [
        {
          name: 'Test',
          request: { method: 'GET', url: 'https://api.test.com/{{a}}' },
        },
      ],
      variable: [
        { key: 'a', value: '{{b}}' },
        { key: 'b', value: '{{c}}' },
        { key: 'c', value: 'leaf' },
      ],
    };

    const filePath = resolve(tempDir, 'chain.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.url).toBe('https://api.test.com/leaf');
  });

  it('terminates on a variable cycle ({{a}}<->{{b}}), leaving an unresolved token as-is', async () => {
    // {{a}} -> {{b}} -> {{a}} -> ... never reaches a fixed point, so the pass cap
    // must stop it. The header value is the cleanest place to observe the result
    // because it is not re-parsed as a URL.
    const collection = {
      info: { name: 'Cycle', schema: '' },
      item: [
        {
          name: 'Test',
          request: {
            method: 'GET',
            url: 'https://api.test.com/ok',
            header: [{ key: 'X-Cycle', value: '{{a}}' }],
          },
        },
      ],
      variable: [
        { key: 'a', value: '{{b}}' },
        { key: 'b', value: '{{a}}' },
      ],
    };

    const filePath = resolve(tempDir, 'cycle.json');
    await writeFile(filePath, JSON.stringify(collection));

    // Must resolve (not hang). After the cap, an unresolved {{a}} or {{b}} token
    // is left verbatim — the assertion just requires termination + a surviving token.
    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    const headerValue = entries[0].request.headers.find((h) => h.name === 'X-Cycle')?.value;
    expect(headerValue === '{{a}}' || headerValue === '{{b}}').toBe(true);
  });

  it('leaves a fully-unknown variable untouched (preserves existing behavior)', async () => {
    const collection = {
      info: { name: 'Unknown', schema: '' },
      item: [
        {
          name: 'Test',
          request: {
            method: 'GET',
            url: 'https://api.test.com/ok',
            header: [{ key: 'X-Unknown', value: '{{missing}}' }],
          },
        },
      ],
      variable: [],
    };

    const filePath = resolve(tempDir, 'unknown.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries[0].request.headers.find((h) => h.name === 'X-Unknown')?.value).toBe(
      '{{missing}}',
    );
  });

  it('R23-B: query: [null] in an object url does not throw; non-null query params are appended', async () => {
    const collection = {
      info: { name: 'NullQuery', schema: '' },
      item: [
        {
          name: 'QueryRequest',
          request: {
            method: 'GET',
            url: {
              protocol: 'https',
              host: ['api', 'test', 'com'],
              path: ['items'],
              query: [null, { key: 'page', value: '2' }] as unknown[],
            },
          },
        },
      ],
    };

    const filePath = resolve(tempDir, 'null-query.json');
    await writeFile(filePath, JSON.stringify(collection));

    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.url).toContain('page=2');
  });

  // -------------------------------------------------------------------------
  // R23-C: a disabled query param exported with value:null (the standard
  // Postman representation) must not throw `.replace` on null and abort the
  // whole import. The null-valued entry is skipped; sibling requests survive.
  // -------------------------------------------------------------------------
  it('R23-C: object-url query with { value: null, disabled: true } is skipped; both requests still import', async () => {
    const collection = {
      info: { name: 'NullValueQuery', schema: '' },
      item: [
        {
          name: 'Req1',
          request: {
            method: 'GET',
            // Structured (object) url — no `raw`, so the protocol/host/path/query
            // branch of resolveUrl runs (the one that loops over query entries).
            url: {
              protocol: 'https',
              host: ['api', 'test', 'com'],
              path: ['search'],
              // Postman exports a disabled param with value:null — this previously
              // crashed resolveVars(null) and aborted the entire collection import.
              query: [{ key: 'foo', value: null, disabled: true }],
            },
          },
        },
        {
          name: 'Req2',
          request: {
            method: 'GET',
            url: {
              protocol: 'https',
              host: ['api', 'test', 'com'],
              path: ['items'],
              query: [{ key: 'page', value: '2' }],
            },
          },
        },
      ],
    };

    const filePath = resolve(tempDir, 'null-value-query.json');
    await writeFile(filePath, JSON.stringify(collection));

    // The null-valued param must not abort the import: BOTH requests survive.
    const { entries } = await loadPostmanCollection(filePath);
    expect(entries).toHaveLength(2);

    // Req2's valid query param is preserved verbatim.
    const req2 = entries.find((e) => e.request.url.includes('/items'));
    expect(req2).toBeDefined();
    expect(new URL(req2!.request.url).searchParams.get('page')).toBe('2');

    // The null-valued param's key is NOT present on Req1's resulting URL.
    const req1 = entries.find((e) => e.request.url.includes('/search'));
    expect(req1).toBeDefined();
    expect(new URL(req1!.request.url).searchParams.has('foo')).toBe(false);
  });
});
