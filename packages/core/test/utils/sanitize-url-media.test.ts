import { describe, it, expect } from 'vitest';
import {
  sanitizeUrlLiteral,
  resolveServerUrl,
  sanitizeMediaType,
  escapeStringLiteral,
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

describe('escapeStringLiteral (L-crstrip — escape CR, do not strip)', () => {
  it('escapes a carriage return as \\r instead of deleting it', () => {
    const out = escapeStringLiteral('a\rb');
    expect(out).not.toContain('\r');
    expect(out).toBe('a\\rb');
  });

  it('round-trips a CR-bearing string back through a valid TS literal', () => {
    const original = "line1\rline2\r\nwith ' quote \\ and end";
    const literal = `'${escapeStringLiteral(original)}'`;
    // The escaped literal is valid JS and evaluates back to the exact input,
    // proving the CR survives (round-trips) rather than being silently dropped.
    // eslint-disable-next-line no-eval
    expect(eval(literal)).toBe(original);
  });

  it('keeps injection chars neutralized (no bare quote, CR or LF)', () => {
    const out = escapeStringLiteral("evil'); code(); //\r\n");
    expect(out).not.toMatch(/[^\\]'/);
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\n');
    expect(out).toContain('\\r');
    expect(out).toContain('\\n');
    // Backslashes are escaped first, so nothing is double-escaped.
    expect(escapeStringLiteral('\\r')).toBe('\\\\r');
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
