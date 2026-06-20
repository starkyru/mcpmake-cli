import { describe, it, expect } from 'vitest';
import { parseIntFlag } from '../../src/commands/rescan.js';

describe('rescan parseIntFlag', () => {
  it('falls back to the descriptor-derived default when the flag is unset', () => {
    expect(parseIntFlag(undefined, 'depth', 4)).toBe(4);
    expect(parseIntFlag('', 'max-pages', 12)).toBe(12);
  });

  it('parses a valid override', () => {
    expect(parseIntFlag('3', 'depth', 2)).toBe(3);
  });

  it('rejects non-numeric input rather than zeroing crawl scope', () => {
    expect(() => parseIntFlag('abc', 'max-pages', 12)).toThrow(/Invalid --max-pages/);
  });

  it('rejects negative input', () => {
    expect(() => parseIntFlag('-1', 'depth', 2)).toThrow(/Invalid --depth/);
  });
});
