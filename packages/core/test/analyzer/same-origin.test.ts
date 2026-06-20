import { describe, it, expect } from 'vitest';
import { isSameOrigin } from '../../src/analyzer/dom-parser.js';

describe('D-M1: same-origin admission uses parsed URL.origin, not string prefix', () => {
  const base = 'https://example.com';

  it('admits genuine same-origin URLs (and benign paths/queries)', () => {
    expect(isSameOrigin('https://example.com/', base)).toBe(true);
    expect(isSameOrigin('https://example.com/products?id=1', base)).toBe(true);
    expect(isSameOrigin('https://example.com/a/b/c', base)).toBe(true);
  });

  it('rejects prefix-spoofing hosts that startsWith would have admitted', () => {
    // The classic bypass: the attacker host begins with the base string.
    expect('https://example.com.attacker.test/steal'.startsWith(base)).toBe(true);
    expect(isSameOrigin('https://example.com.attacker.test/steal', base)).toBe(false);
    expect(isSameOrigin('https://example.com-evil.test/', base)).toBe(false);
  });

  it('rejects different scheme, host, and port', () => {
    expect(isSameOrigin('http://example.com/', base)).toBe(false); // scheme
    expect(isSameOrigin('https://other.example.com/', base)).toBe(false); // subdomain
    expect(isSameOrigin('https://example.com:8443/', base)).toBe(false); // port
  });

  it('rejects unparseable hrefs', () => {
    expect(isSameOrigin('javascript:alert(1)', base)).toBe(false);
    expect(isSameOrigin('not a url', base)).toBe(false);
  });
});
