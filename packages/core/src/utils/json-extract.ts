/**
 * Robust extraction of JSON from raw LLM output.
 *
 * Models frequently wrap JSON in ```json fences or surround it with prose
 * ("Here is the spec:" / "Hope this helps!"). These helpers locate the first
 * balanced JSON value and return its exact substring, ignoring delimiters that
 * appear inside quoted strings. The scan is single-pass and linear-time — no
 * regex over the body, so there is no catastrophic-backtracking risk.
 */

/**
 * Return the substring spanning the first balanced top-level value opened by
 * `open` (and closed by the matching `close`) in `text`, or null if none.
 * String-aware: braces/brackets inside quoted strings are ignored.
 */
function extractBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Return the substring spanning the first balanced top-level `{...}` object in
 * `text`, or null if none. Robust to markdown fences and leading/trailing prose.
 */
export function extractJsonObject(text: string): string | null {
  return extractBalanced(text, '{', '}');
}

/**
 * Return the substring spanning the first balanced top-level JSON value in
 * `text` — an object (`{...}`) or an array (`[...]`), whichever opens first —
 * or null if none. Robust to markdown fences and leading/trailing prose.
 */
export function extractJsonValue(text: string): string | null {
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');

  if (objStart === -1 && arrStart === -1) return null;
  // Whichever delimiter appears first wins; -1 means "not present".
  const objFirst = arrStart === -1 || (objStart !== -1 && objStart < arrStart);

  return objFirst ? extractBalanced(text, '{', '}') : extractBalanced(text, '[', ']');
}
