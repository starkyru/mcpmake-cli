import { describe, it, expect } from 'vitest';
import { normalizeEntry } from '../../src/parser/har-normalizer.js';
import type { Entry } from 'har-format';

function makeEntry(url: string, method = 'GET'): Entry {
  return {
    startedDateTime: '2024-01-01T00:00:00.000Z',
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

describe('har-normalizer', () => {
  it('detects numeric IDs in paths', () => {
    const result = normalizeEntry(makeEntry('https://api.example.com/users/42'));
    expect(result.normalizedPath).toBe('/users/{userId}');
    expect(result.pathParams).toHaveLength(1);
    expect(result.pathParams[0].name).toBe('userId');
    expect(result.pathParams[0].inferredType).toBe('integer');
  });

  it('detects UUIDs in paths', () => {
    const result = normalizeEntry(
      makeEntry('https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000'),
    );
    expect(result.normalizedPath).toBe('/users/{userId}');
    expect(result.pathParams[0].inferredType).toBe('uuid');
  });

  it('preserves non-ID segments', () => {
    const result = normalizeEntry(makeEntry('https://api.example.com/v1/users'));
    expect(result.normalizedPath).toBe('/v1/users');
    expect(result.pathParams).toHaveLength(0);
  });

  it('handles multiple path params', () => {
    const result = normalizeEntry(makeEntry('https://api.example.com/users/42/posts/99'));
    expect(result.normalizedPath).toBe('/users/{userId}/posts/{postId}');
    expect(result.pathParams).toHaveLength(2);
  });

  it('extracts baseUrl', () => {
    const result = normalizeEntry(makeEntry('https://api.example.com/v1/users'));
    expect(result.baseUrl).toBe('https://api.example.com');
  });

  it('extracts query params', () => {
    const entry = makeEntry('https://api.example.com/users?limit=10&active=true');
    entry.request.queryString = [
      { name: 'limit', value: '10' },
      { name: 'active', value: 'true' },
    ];
    const result = normalizeEntry(entry);
    expect(result.queryParams).toHaveLength(2);
    expect(result.queryParams[0].inferredType).toBe('integer');
    expect(result.queryParams[1].inferredType).toBe('boolean');
  });

  // ---------------------------------------------------------------------------
  // isCollectionName tightening: the heuristic used to be near-vacuously true
  // (any segment except api/v1/v2/v3), over-parameterizing short-id segments
  // that follow a *singular* word. After tightening, only plural resource
  // segments are treated as collections.
  //
  // The SHORT_ID_PATTERN branch only fires for an alphanumeric 8-22 char segment
  // that is NOT a UUID / numeric / 24-hex id, so we use such a value below.
  // ---------------------------------------------------------------------------
  it('parameterizes a short-id segment after a PLURAL collection (orders -> {orderId})', () => {
    const result = normalizeEntry(makeEntry('https://api.example.com/orders/AB12cd34ef'));
    expect(result.normalizedPath).toBe('/orders/{orderId}');
    expect(result.pathParams).toHaveLength(1);
    expect(result.pathParams[0].name).toBe('orderId');
  });

  it('does NOT parameterize a short-id segment after a SINGULAR word (profile stays literal)', () => {
    // Pre-tightening, `profile` counted as a collection and this became
    // /profile/{profileId}. The tightened heuristic rejects the singular word,
    // so the short id is left as a literal segment.
    const result = normalizeEntry(makeEntry('https://api.example.com/profile/AB12cd34ef'));
    expect(result.normalizedPath).toBe('/profile/AB12cd34ef');
    expect(result.pathParams).toHaveLength(0);
  });

  it('does NOT treat a version prefix (v1) as a collection when naming a following numeric id', () => {
    // `v1` is excluded; without a collection prev segment the numeric id falls
    // back to the generic `id` name rather than `v1Id`/`vId`.
    const result = normalizeEntry(makeEntry('https://api.example.com/v1/42'));
    expect(result.normalizedPath).toBe('/v1/{id}');
    expect(result.pathParams[0].name).toBe('id');
  });

  it('normalizes entry with no queryString field without throwing (R19-A)', () => {
    // Safari Web Inspector and older Charles Proxy omit queryString entirely
    // when there is no query component on the request URL. The HAR spec marks
    // the field as optional. Before the fix this caused a TypeError at runtime.
    const entry = makeEntry('https://api.example.com/users/42');
    // Simulate a real-world HAR export where queryString is simply absent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (entry.request as any).queryString;

    const result = normalizeEntry(entry);
    expect(result.queryParams).toHaveLength(0);
    expect(result.normalizedPath).toBe('/users/{userId}');
  });

  it('skips malformed queryString entries while preserving valid siblings', () => {
    const entry = makeEntry('https://api.example.com/users?limit=10');
    entry.request.queryString = [
      null,
      { name: 'missing-value' },
      { name: 'limit', value: '10' },
    ] as unknown as Entry['request']['queryString'];

    const result = normalizeEntry(entry);
    expect(result.queryParams).toEqual([
      { name: 'limit', exampleValue: '10', inferredType: 'integer' },
    ]);
  });
});
