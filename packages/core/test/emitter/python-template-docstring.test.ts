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

  it('escapes EVERY double-quote (not just literal """ runs) so a trailing quote cannot terminate the docstring', () => {
    // Regression: the old code escaped only literal `"""` runs, leaving a lone
    // trailing/adjacent `"` intact. A description ending in `"` emitted into
    // `"""{{pyDocstring}}"""` produced four consecutive quotes at the close →
    // Python `SyntaxError: unterminated string literal` → server.py failed to import.

    // 1) Exact hand-derived output: each `"` becomes `\"` (backslash + quote).
    const result = pyDocstring('Search the "Inbox"');
    expect(result).toBe('Search the \\"Inbox\\"');

    // 2) No run of two-or-more unescaped quotes: the output cannot contribute a
    //    `""` that fuses with the closing `"""`.
    expect(result).not.toContain('""');
    // The same holds for a description ENDING in two quotes — the case the old
    // code left as a literal `""` run (the buggy output kept them unescaped).
    expect(pyDocstring('ends in two quotes""')).not.toContain('""');

    // 3) Construct the FULL emitted docstring line and prove the close is safe:
    //    every double-quote in the description body is backslash-escaped, so it
    //    cannot terminate the string early. (The bug left bare quotes here, which
    //    is the exact SyntaxError condition.)
    const body = pyDocstring('ends in a quote"');
    const line = '    """' + body + '"""';
    // The body portion (between the opening and closing `"""`) must contain no
    // UNescaped double-quote — i.e. every `"` is preceded by a backslash.
    expect(body).not.toMatch(/(^|[^\\])"/);
    // And the emitted line still opens and closes with exactly three quotes.
    expect(line.startsWith('    """')).toBe(true);
    expect(line.endsWith('"""')).toBe(true);
  });
});
