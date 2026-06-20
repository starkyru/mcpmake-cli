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
});
