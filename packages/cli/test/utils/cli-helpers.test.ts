import { describe, it, expect } from 'vitest';
import { toPackageName, parseIntFlag } from '../../src/utils/cli-helpers.js';

describe('toPackageName', () => {
  it('lowercases and collapses non-alphanumeric runs into single dashes', () => {
    expect(toPackageName('My API v2')).toBe('my-api-v2');
    expect(toPackageName('Acme   Corp')).toBe('acme-corp');
  });

  it('turns dots in a hostname into dashes', () => {
    expect(toPackageName('api.example.com')).toBe('api-example-com');
  });

  it('trims leading and trailing dashes produced by edge punctuation', () => {
    expect(toPackageName('!!Hello World!!')).toBe('hello-world');
    expect(toPackageName('---weird---')).toBe('weird');
  });

  it('collapses a run of mixed separators into one dash', () => {
    expect(toPackageName('foo / bar _ baz')).toBe('foo-bar-baz');
  });

  it('returns an empty string when there are no alphanumerics', () => {
    expect(toPackageName('!!!')).toBe('');
    expect(toPackageName('')).toBe('');
  });

  it('leaves an already-clean slug unchanged', () => {
    expect(toPackageName('already-clean-123')).toBe('already-clean-123');
  });
});

describe('parseIntFlag', () => {
  it('returns the fallback when the value is undefined', () => {
    expect(parseIntFlag(undefined, 'depth', 2)).toBe(2);
  });

  it('returns the fallback when the value is an empty string', () => {
    expect(parseIntFlag('', 'max-pages', 20)).toBe(20);
  });

  it('parses a valid non-negative integer', () => {
    expect(parseIntFlag('5', 'max-pages', 20)).toBe(5);
    expect(parseIntFlag('300', 'timeout', 300)).toBe(300);
  });

  it('accepts an explicit zero rather than falling back', () => {
    // 0 is a valid value and must NOT be replaced by the fallback (7).
    expect(parseIntFlag('0', 'static-tools', 7)).toBe(0);
  });

  it('rejects non-numeric input instead of coercing it to 0', () => {
    // The whole point of this helper: "abc" must throw, not silently become 0.
    expect(() => parseIntFlag('abc', 'static-tools', 0)).toThrow(
      'Invalid --static-tools: "abc" (expected a non-negative integer)',
    );
  });

  it('rejects negative integers', () => {
    expect(() => parseIntFlag('-3', 'depth', 2)).toThrow(
      'Invalid --depth: "-3" (expected a non-negative integer)',
    );
  });

  it('rejects non-integer (fractional) values', () => {
    expect(() => parseIntFlag('2.5', 'depth', 2)).toThrow(
      'Invalid --depth: "2.5" (expected a non-negative integer)',
    );
  });

  it('rejects a bare hex prefix that Number() would not parse to an integer', () => {
    // Number('0x') === NaN, so this must throw rather than be mis-accepted.
    expect(() => parseIntFlag('0x', 'static-tools', 0)).toThrow(
      'Invalid --static-tools: "0x" (expected a non-negative integer)',
    );
  });

  it('names the offending flag in the error message', () => {
    expect(() => parseIntFlag('nope', 'max-sessions', 10)).toThrow(/--max-sessions/);
  });
});
