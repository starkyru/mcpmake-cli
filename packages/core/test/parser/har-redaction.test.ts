import { describe, it, expect } from 'vitest';
import type { Entry } from 'har-format';
import { filterHarEntries, redactEntrySecrets } from '../../src/parser/har-filter.js';

/**
 * L-recorder-secret: recorded HAR must never persist live credentials.
 * Sensitive header/cookie VALUES are scrubbed while names (and auth schemes)
 * are preserved so downstream auth detection still works.
 */

function makeEntry(overrides: Partial<Entry['request']> = {}): Entry {
  return {
    startedDateTime: new Date(0).toISOString(),
    time: 1,
    request: {
      method: 'GET',
      url: 'https://api.example.com/users',
      httpVersion: 'HTTP/1.1',
      headers: [
        { name: 'Authorization', value: 'Bearer SECRET-TOKEN-XYZ' },
        { name: 'Cookie', value: 's=Y; theme=dark' },
        { name: 'X-Api-Key', value: 'live_key_123' },
        { name: 'Accept', value: 'application/json' },
        ...(overrides.headers ?? []),
      ],
      queryString: [],
      cookies: [{ name: 'session', value: 'super-secret' }],
      headersSize: -1,
      bodySize: 0,
      ...overrides,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [
        { name: 'Set-Cookie', value: 'session=abc123; Path=/; HttpOnly; Secure' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      cookies: [{ name: 'session', value: 'abc123' }],
      content: { size: 2, mimeType: 'application/json', text: '{}' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 2,
    },
    cache: {},
    timings: { send: 1, wait: 1, receive: 1 },
  };
}

function headerValue(entry: Entry, name: string): string | undefined {
  return entry.request.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

describe('har redaction (L-recorder-secret)', () => {
  it('redacts Authorization and Cookie values but keeps names and scheme', () => {
    const entry = redactEntrySecrets(makeEntry());

    const auth = headerValue(entry, 'authorization');
    expect(auth).toBe('Bearer <redacted>');
    expect(auth).not.toContain('SECRET-TOKEN-XYZ');

    const cookie = headerValue(entry, 'cookie');
    expect(cookie).toContain('s=<redacted>');
    expect(cookie).toContain('theme=<redacted>');
    expect(cookie).not.toContain('Y');

    expect(headerValue(entry, 'x-api-key')).toBe('<redacted>');
    // Non-sensitive header is untouched.
    expect(headerValue(entry, 'accept')).toBe('application/json');
  });

  it('redacts response Set-Cookie value while preserving cookie name and attributes', () => {
    const entry = redactEntrySecrets(makeEntry());
    const setCookie = entry.response.headers.find((h) => h.name.toLowerCase() === 'set-cookie')!;
    // Cookie value scrubbed; attributes (Path, HttpOnly, Secure) untouched.
    expect(setCookie.value).toBe('session=<redacted>; Path=/; HttpOnly; Secure');
    expect(setCookie.value).not.toContain('abc123');
  });

  it('redacts parsed request/response cookie arrays', () => {
    const entry = redactEntrySecrets(makeEntry());
    expect(entry.request.cookies?.[0]?.value).toBe('<redacted>');
    expect(entry.response.cookies?.[0]?.value).toBe('<redacted>');
  });

  it('is idempotent (running twice does not corrupt values)', () => {
    const once = redactEntrySecrets(makeEntry());
    const onceAuth = headerValue(once, 'authorization');
    const twice = redactEntrySecrets(once);
    expect(headerValue(twice, 'authorization')).toBe(onceAuth);
    expect(headerValue(twice, 'authorization')).toBe('Bearer <redacted>');
  });

  it('filterHarEntries scrubs secrets from kept entries', () => {
    const kept = filterHarEntries([makeEntry()], { allowedDomains: ['api.example.com'] });
    expect(kept).toHaveLength(1);
    const auth = headerValue(kept[0], 'authorization');
    expect(auth).toBe('Bearer <redacted>');
    expect(JSON.stringify(kept[0])).not.toContain('SECRET-TOKEN-XYZ');
    expect(JSON.stringify(kept[0])).not.toContain('live_key_123');
  });

  it('preserves Basic scheme word for downstream detection', () => {
    const entry = redactEntrySecrets(
      makeEntry({ headers: [{ name: 'Authorization', value: 'Basic dXNlcjpwYXNz' }] }),
    );
    // Two Authorization headers exist (Bearer default + injected Basic); ensure
    // the injected Basic one keeps its scheme.
    const auths = entry.request.headers
      .filter((h) => h.name.toLowerCase() === 'authorization')
      .map((h) => h.value);
    expect(auths).toContain('Basic <redacted>');
    expect(auths.join(' ')).not.toContain('dXNlcjpwYXNz');
  });
});
