import { describe, it, expect } from 'vitest';
import type { Entry, QueryString } from 'har-format';
import { normalizeEntry } from '../../src/parser/har-normalizer.js';
import { clusterEntries } from '../../src/transformer/har-clusterer.js';
import { clustersToOperations } from '../../src/transformer/har-to-operations.js';

function makeEntry(url: string, queryString: QueryString[] = [], method = 'GET'): Entry {
  return {
    startedDateTime: '2024-01-01T00:00:00.000Z',
    time: 100,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: [],
      queryString,
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

function convert(entries: Entry[]) {
  const clusters = clusterEntries(entries.map(normalizeEntry));
  return clustersToOperations(clusters);
}

const SECRET = 'sk_live_DEADBEEFCAFEBABE';

describe('har-to-operations query-string auth (M10)', () => {
  it('detects ?api_key=... as apiKey auth in query and never emits the literal secret', () => {
    const entry = makeEntry('https://api.example.com/v1/items?api_key=' + SECRET, [
      { name: 'api_key', value: SECRET },
    ]);
    const result = convert([entry]);

    // Detected as auth (apiKey, located in query) — not a plain query param.
    expect(result.detectedAuth).toHaveLength(1);
    expect(result.detectedAuth[0].type).toBe('apiKey');
    expect(result.detectedAuth[0].in).toBe('query');
    expect(result.detectedAuth[0].headerName).toBe('api_key');

    // The secret value must never appear anywhere in the generated output.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);

    // The auth key is not surfaced as an ordinary query parameter.
    const op = result.operations[0];
    expect(op.parameters.find((p) => p.in === 'query' && p.name === 'api_key')).toBeUndefined();
    expect(op.security.some((s) => s.schemeName === 'apiKey')).toBe(true);
  });

  it.each([
    'apikey',
    'access_token',
    'token',
    'auth',
    'key',
    'sig',
    'signature',
    'password',
    'secret',
  ])('treats query key %s as auth and redacts its value', (authKey) => {
    const entry = makeEntry('https://api.example.com/v1/items?' + authKey + '=' + SECRET, [
      { name: authKey, value: SECRET },
    ]);
    const result = convert([entry]);

    expect(result.detectedAuth).toHaveLength(1);
    expect(result.detectedAuth[0].in).toBe('query');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('matches auth query keys case-insensitively', () => {
    const entry = makeEntry('https://api.example.com/v1/items?API_KEY=' + SECRET, [
      { name: 'API_KEY', value: SECRET },
    ]);
    const result = convert([entry]);

    expect(result.detectedAuth).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('redacts auth query secrets across every entry in a cluster (not just canonical)', () => {
    const other = 'tok_OTHER_ENTRY_SECRET';
    const a = makeEntry('https://api.example.com/v1/items?token=' + SECRET, [
      { name: 'token', value: SECRET },
    ]);
    const b = makeEntry('https://api.example.com/v1/items?token=' + other, [
      { name: 'token', value: other },
    ]);
    const result = convert([a, b]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(other);
  });

  it('does not misclassify or drop non-auth query params', () => {
    const entry = makeEntry('https://api.example.com/v1/items?page=2&limit=50', [
      { name: 'page', value: '2' },
      { name: 'limit', value: '50' },
    ]);
    const result = convert([entry]);

    expect(result.detectedAuth).toHaveLength(0);
    const op = result.operations[0];
    const queryNames = op.parameters.filter((p) => p.in === 'query').map((p) => p.name);
    expect(queryNames).toEqual(expect.arrayContaining(['page', 'limit']));
  });

  it('keeps non-auth params while redacting auth params in the same request', () => {
    const entry = makeEntry('https://api.example.com/v1/items?page=2&api_key=' + SECRET, [
      { name: 'page', value: '2' },
      { name: 'api_key', value: SECRET },
    ]);
    const result = convert([entry]);

    const op = result.operations[0];
    const queryNames = op.parameters.filter((p) => p.in === 'query').map((p) => p.name);
    expect(queryNames).toContain('page');
    expect(queryNames).not.toContain('api_key');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
