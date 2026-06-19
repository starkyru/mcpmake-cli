import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Entry } from 'har-format';
import { filterHarEntries } from '../../src/parser/har-filter.js';
import { normalizeEntry } from '../../src/parser/har-normalizer.js';
import { clusterEntries } from '../../src/transformer/har-clusterer.js';
import { clustersToOperations } from '../../src/transformer/har-to-operations.js';
import { buildAllTools } from '../../src/transformer/tool-builder.js';
import { emitProject } from '../../src/emitter/index.js';
import { pathExists } from '../../src/utils/fs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Simulates what the browser recorder captures: a set of HAR entries
 * as if a user browsed an API-backed website.
 */
function simulateBrowserCapture(): Entry[] {
  const base = {
    cache: {} as Entry['cache'],
    timings: { send: 1, wait: 50, receive: 10 },
  };

  return [
    // API call: list items
    {
      ...base,
      startedDateTime: '2024-01-01T00:00:00.000Z',
      time: 100,
      request: {
        method: 'GET',
        url: 'https://app.example.com/api/v1/items?page=1&limit=20',
        httpVersion: 'HTTP/1.1',
        headers: [
          { name: 'authorization', value: 'Bearer test-token-xyz' },
          { name: 'accept', value: 'application/json' },
        ],
        queryString: [
          { name: 'page', value: '1' },
          { name: 'limit', value: '20' },
        ],
        cookies: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'content-type', value: 'application/json' }],
        cookies: [],
        content: {
          size: 100,
          mimeType: 'application/json',
          text: '[{"id":1,"name":"Widget"},{"id":2,"name":"Gadget"}]',
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: 100,
      },
    },
    // API call: get single item
    {
      ...base,
      startedDateTime: '2024-01-01T00:00:01.000Z',
      time: 80,
      request: {
        method: 'GET',
        url: 'https://app.example.com/api/v1/items/42',
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'authorization', value: 'Bearer test-token-xyz' }],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'content-type', value: 'application/json' }],
        cookies: [],
        content: {
          size: 50,
          mimeType: 'application/json',
          text: '{"id":42,"name":"Widget","price":9.99}',
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: 50,
      },
    },
    // Noise: static asset
    {
      ...base,
      startedDateTime: '2024-01-01T00:00:02.000Z',
      time: 20,
      request: {
        method: 'GET',
        url: 'https://app.example.com/assets/logo.png',
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
        headers: [{ name: 'content-type', value: 'image/png' }],
        cookies: [],
        content: { size: 5000, mimeType: 'image/png' },
        redirectURL: '',
        headersSize: -1,
        bodySize: 5000,
      },
    },
    // Noise: analytics
    {
      ...base,
      startedDateTime: '2024-01-01T00:00:03.000Z',
      time: 200,
      request: {
        method: 'GET',
        url: 'https://www.google-analytics.com/collect?v=1',
        httpVersion: 'HTTP/1.1',
        headers: [],
        queryString: [{ name: 'v', value: '1' }],
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
        content: { size: 0, mimeType: 'image/gif' },
        redirectURL: '',
        headersSize: -1,
        bodySize: 0,
      },
    },
    // API call: create item
    {
      ...base,
      startedDateTime: '2024-01-01T00:00:04.000Z',
      time: 150,
      request: {
        method: 'POST',
        url: 'https://app.example.com/api/v1/items',
        httpVersion: 'HTTP/1.1',
        headers: [
          { name: 'authorization', value: 'Bearer test-token-xyz' },
          { name: 'content-type', value: 'application/json' },
        ],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: 40,
        postData: {
          mimeType: 'application/json',
          text: '{"name":"New Item","price":19.99}',
        },
      },
      response: {
        status: 201,
        statusText: 'Created',
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'content-type', value: 'application/json' }],
        cookies: [],
        content: {
          size: 60,
          mimeType: 'application/json',
          text: '{"id":3,"name":"New Item","price":19.99}',
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: 60,
      },
    },
  ];
}

describe('URL recorder pipeline (simulated)', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-url-test-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('filters noise from browser captures', () => {
    const entries = simulateBrowserCapture();
    const filtered = filterHarEntries(entries, {
      allowedDomains: ['app.example.com'],
    });
    // Should keep 3 API calls, filter out logo.png and analytics
    expect(filtered).toHaveLength(3);
  });

  it('normalizes and clusters captured requests', () => {
    const entries = simulateBrowserCapture();
    const filtered = filterHarEntries(entries, {
      allowedDomains: ['app.example.com'],
    });
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);

    expect(clusters.length).toBe(3); // GET /items, GET /items/{id}, POST /items
    const signatures = clusters.map((c) => c.signature);
    expect(signatures).toContain('GET /api/v1/items');
    expect(signatures).toContain('POST /api/v1/items');
  });

  it('detects auth from browser headers', () => {
    const entries = simulateBrowserCapture();
    const filtered = filterHarEntries(entries, {
      allowedDomains: ['app.example.com'],
    });
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);
    const { detectedAuth } = clustersToOperations(clusters);

    expect(detectedAuth.some((a) => a.type === 'bearer')).toBe(true);
    expect(detectedAuth[0].exampleValue).toBe('[REDACTED]');
  });

  it('generates a full project from captured traffic', async () => {
    const entries = simulateBrowserCapture();
    const filtered = filterHarEntries(entries, {
      allowedDomains: ['app.example.com'],
    });
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);
    const { operations, baseUrl } = clustersToOperations(clusters);
    const tools = buildAllTools(operations);

    expect(tools.length).toBe(3);

    await emitProject(
      {
        serverName: 'test-url-server',
        transport: 'stdio' as const,
        serverVersion: '1.0.0',
        baseUrl,
        tools,
        authSchemes: [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN' }],
        envVars: [
          { name: 'BASE_URL', description: 'API base URL', required: true },
          { name: 'BEARER_TOKEN', description: 'Bearer token', required: true },
        ],
      },
      { outputDir, force: true, dryRun: false },
    );

    expect(await pathExists(resolve(outputDir, 'package.json'))).toBe(true);
    expect(await pathExists(resolve(outputDir, 'src/tools/index.ts'))).toBe(true);

    const toolIndex = await readFile(resolve(outputDir, 'src/tools/index.ts'), 'utf-8');
    for (const tool of tools) {
      expect(toolIndex).toContain(tool.fileName);
    }
  });

  it('infers request body schema from POST data', () => {
    const entries = simulateBrowserCapture();
    const filtered = filterHarEntries(entries, {
      allowedDomains: ['app.example.com'],
    });
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);
    const { operations } = clustersToOperations(clusters);

    const postOp = operations.find((op) => op.method === 'post');
    expect(postOp).toBeDefined();
    expect(postOp!.requestBody).toBeDefined();
    expect(postOp!.requestBody!.contentType).toBe('application/json');
  });
});
