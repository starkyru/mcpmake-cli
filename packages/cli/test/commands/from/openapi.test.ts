/**
 * Tests for openapi and stainless command parseIntFlag guards (A4-7).
 *
 * Verify that non-numeric / negative --static-tools input is rejected with a
 * clear error instead of silently passing NaN into staticToolCount.
 */

import { describe, it, expect } from 'vitest';
import { parseIntFlag } from '../../../src/commands/from/website.js';

// parseIntFlag is the shared helper now used by openapi.ts, stainless.ts, and
// url.ts. Its correctness is the single source of truth for all three commands.
// Additional focused contract tests live here to document the static-tools use case.
describe('parseIntFlag — static-tools / timeout guard (A4-7)', () => {
  it('returns undefined-sentinel (0) for empty string — mirrors "flag not set" path', () => {
    // When args['static-tools'] is undefined, callers skip parseIntFlag entirely.
    // When it is '', parseIntFlag returns the fallback (0), which is safe to pass
    // as staticToolCount: emitter treats 0 as "no static tools".
    expect(parseIntFlag('', 'static-tools', 0)).toBe(0);
  });

  it('parses "5" → 5 (valid positive count)', () => {
    expect(parseIntFlag('5', 'static-tools', 0)).toBe(5);
  });

  it('parses "0" → 0 (explicit zero is valid)', () => {
    expect(parseIntFlag('0', 'static-tools', 0)).toBe(0);
  });

  it('throws on non-numeric string (would have been NaN before fix)', () => {
    // Pre-fix: parseInt('abc', 10) === NaN, which would silently propagate.
    expect(() => parseIntFlag('abc', 'static-tools', 0)).toThrow(/Invalid --static-tools/);
  });

  it('throws on negative value', () => {
    expect(() => parseIntFlag('-1', 'static-tools', 0)).toThrow(/Invalid --static-tools/);
  });

  it('throws on float (not an integer)', () => {
    expect(() => parseIntFlag('2.5', 'static-tools', 0)).toThrow(/Invalid --static-tools/);
  });

  it('rejects NaN-producing strings that parseInt would silently accept as 0', () => {
    // parseInt('0x', 10) === 0 but Number('0x') === NaN → parseIntFlag throws.
    // This confirms the guard catches inputs parseInt would wrongly accept.
    expect(() => parseIntFlag('0x', 'static-tools', 0)).toThrow(/Invalid --static-tools/);
  });

  it('timeout: "abc" throws with the correct flag name', () => {
    expect(() => parseIntFlag('abc', 'timeout', 300)).toThrow(/Invalid --timeout/);
  });

  it('timeout: undefined → fallback 300 (default when flag not provided)', () => {
    expect(parseIntFlag(undefined, 'timeout', 300)).toBe(300);
  });

  it('timeout: "60" → 60', () => {
    expect(parseIntFlag('60', 'timeout', 300)).toBe(60);
  });
});
