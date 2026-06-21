/**
 * A4-5: pyDocstring escape-order regression.
 *
 * The old code did:  .replace(/"""/g, '\"\"\"').replace(/\\/g, '\\\\')
 * which re-escapes the backslashes inserted in the first pass.
 *
 * The fixed code does backslash-first so each step only touches its own chars.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Handlebars from 'handlebars';

// Importing the module triggers the Handlebars.registerHelper side-effects.
beforeAll(async () => {
  await import('../../src/emitter/python-template-loader.js');
});

function pyDocstring(str: string): string {
  // Retrieve the registered helper and invoke it the same way Handlebars does.
  const helper = Handlebars.helpers['pyDocstring'] as (str: string) => string;
  return helper(str);
}

describe('pyDocstring (A4-5: backslash-first escape order)', () => {
  it('escapes a plain triple-quote to \\"\\"\\"', () => {
    expect(pyDocstring('say """hello"""')).toBe('say \\"\\"\\"hello\\"\\"\\"');
  });

  it('escapes a plain backslash to \\\\', () => {
    expect(pyDocstring('C:\\Users')).toBe('C:\\\\Users');
  });

  it('does NOT double-escape: backslash adjacent to triple-quote round-trips correctly', () => {
    // Input: foo\"""  (a backslash immediately followed by three double-quotes)
    // Correct output: foo\\\"\"\"  (backslash doubled, then each " in """ becomes \")
    const input = 'foo\\"""';
    const result = pyDocstring(input);
    // The backslash becomes \\ and each " in """ becomes \"; no extra backslashes.
    expect(result).toBe('foo\\\\\\"\\"\\"');
    // Specifically: must NOT contain four or more consecutive backslashes
    // (which would indicate the backslash was double-escaped a second time).
    expect(result).not.toMatch(/\\\\\\\\/);
  });

  it('returns empty string for falsy input', () => {
    expect(pyDocstring('')).toBe('');
  });

  it('leaves strings with no special chars unchanged', () => {
    expect(pyDocstring('Hello, world')).toBe('Hello, world');
  });
});
