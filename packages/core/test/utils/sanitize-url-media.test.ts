import { describe, it, expect } from 'vitest';
import {
  sanitizeUrlLiteral,
  resolveServerUrl,
  sanitizeMediaType,
} from '../../src/utils/sanitize.js';

describe('sanitizeUrlLiteral (D-M4 — escape, do not corrupt)', () => {
  it('preserves legal URL characters that the strip-based version destroyed', () => {
    // `$`, `{`, `}` are legal in real API paths (OData `$metadata`, etc.) and
    // must survive — the new escaper only neutralizes literal-breakout chars.
    expect(sanitizeUrlLiteral('https://api.example.com/v1/$metadata')).toBe(
      'https://api.example.com/v1/$metadata',
    );
    expect(sanitizeUrlLiteral('https://api.example.com/a~b/c.d')).toBe(
      'https://api.example.com/a~b/c.d',
    );
  });

  it('neutralizes quotes, backticks and ${ without removing characters', () => {
    const out = sanitizeUrlLiteral('https://x/"`${y}');
    // The breakout chars are escaped (backslash-prefixed), not stripped.
    expect(out).toContain('\\"');
    expect(out).toContain('\\`');
    expect(out).toContain('\\${');
    // Still no bare quote/backtick that would terminate a literal.
    expect(out).not.toMatch(/[^\\]"/);
    expect(out).not.toMatch(/[^\\]`/);
  });

  it('escapes CR/LF so it cannot inject extra dotenv/TOML lines', () => {
    const out = sanitizeUrlLiteral('https://x\nAPI_KEY=leak');
    expect(out).not.toContain('\n');
    expect(out).toContain('\\n');
  });
});

describe('resolveServerUrl (D-M4 — server variables)', () => {
  it('substitutes server variables from their defaults', () => {
    expect(
      resolveServerUrl('https://{region}.api.test/{version}', {
        region: { default: 'eu' },
        version: { default: 'v2' },
      }),
    ).toBe('https://eu.api.test/v2');
  });

  it('leaves a variable without a known default intact', () => {
    expect(resolveServerUrl('https://api.test/{version}', {})).toBe('https://api.test/{version}');
  });

  it('is a no-op when there are no variables', () => {
    expect(resolveServerUrl('https://api.test/v1')).toBe('https://api.test/v1');
  });
});

describe('sanitizeMediaType (D-C1)', () => {
  it('accepts well-formed media types', () => {
    expect(sanitizeMediaType('application/json')).toBe('application/json');
    expect(sanitizeMediaType('application/x-www-form-urlencoded')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(sanitizeMediaType('multipart/form-data; boundary=abc')).toBe(
      'multipart/form-data; boundary=abc',
    );
  });

  it('replaces a non-media-type / injection payload with the safe default', () => {
    expect(sanitizeMediaType("x'+((globalThis as any).PWNED=true)+'y")).toBe('application/json');
    expect(sanitizeMediaType('not a media type')).toBe('application/json');
    expect(sanitizeMediaType('')).toBe('application/json');
  });
});
