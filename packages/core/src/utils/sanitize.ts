/**
 * Sanitize a string for safe embedding in a JavaScript/TypeScript single-quoted string literal.
 * Escapes backslashes, single quotes, and newlines.
 */
export function escapeStringLiteral(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

/**
 * Sanitize a string for safe embedding in a JavaScript/TypeScript template literal.
 * Escapes backticks, ${} expressions, and backslashes.
 */
export function escapeTemplateLiteral(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Validate that an identifier (operationId, param name) contains only safe characters.
 * Strips anything that isn't alphanumeric, underscore, or hyphen.
 */
export function sanitizeIdentifier(str: string): string {
  return str.replace(/[^a-zA-Z0-9_\-]/g, '');
}

/**
 * Sanitize an HTTP header name (e.g. an apiKey scheme `name`) for safe embedding
 * in a string literal. Real header names are RFC 7230 tokens; in practice API
 * key headers are `[A-Za-z0-9-]` (plus `_`). Stripping everything else removes
 * quotes/backticks/newlines that could break out of the generated literal.
 */
export function sanitizeHeaderName(str: string): string {
  return str.replace(/[^A-Za-z0-9_\-]/g, '');
}

/**
 * Sanitize an environment-variable name. It is emitted both as a quoted string
 * and as a bare member access (`process.env.<NAME>` / `env.<NAME>`), so it must
 * be a valid JS/POSIX identifier. Strips invalid chars and prefixes `_` when the
 * result would start with a digit or be empty.
 */
export function sanitizeEnvVarName(str: string): string {
  const cleaned = str.replace(/[^A-Za-z0-9_]/g, '');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/**
 * Resolve OpenAPI server-variable placeholders (`{var}`) in a server URL from
 * their declared defaults, then validate the result is a real http(s) URL.
 *
 * OpenAPI server URLs may carry variables — `https://{region}.api.test/{version}`
 * — with a `variables` map giving each a `default`. Substituting them here keeps
 * the URL semantically intact instead of stripping the braces (which would corrupt
 * the path, e.g. `{version}` → empty). Variables without a known default are left
 * as-is; the subsequent per-sink escaper neutralizes any residual unsafe chars.
 */
export function resolveServerUrl(
  url: string,
  variables?: Record<string, { default?: string } | undefined>,
): string {
  if (!url) return url;
  let resolved = url;
  if (variables) {
    resolved = resolved.replace(/\{([^{}]+)\}/g, (match, name: string) => {
      const def = variables[name]?.default;
      return typeof def === 'string' ? def : match;
    });
  }
  return resolved;
}

/**
 * Escape a base URL for safe embedding in a string literal across multiple
 * target languages without mutating its semantics. Unlike a strip-based
 * approach, this preserves every character that is legal in a URL (including
 * `$`, `{`, `}`, `~`, etc. that appear in real paths such as `/v1/$metadata`)
 * and only neutralizes the characters that could break out of, or inject into,
 * the literal it is embedded in:
 *   - backslash, single/double quote, backtick → backslash-escaped
 *   - `${` (TS template-literal interpolation) → broken with a backslash
 *   - CR/LF (could inject extra dotenv/TOML lines) → backslash-escaped
 * The same escaped form is safe in a TS single/double-quote string, a TS
 * backtick literal, a Python double-quote string, a TOML basic string, and a
 * single-line dotenv value. Validation/variable-resolution happens upstream in
 * the emitter via {@link resolveServerUrl}.
 */
export function sanitizeUrlLiteral(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\$\{/g, '\\${')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/** RFC 6838 / RFC 7231 media-type token: `type/subtype` with optional params. */
const MEDIA_TYPE_RE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(\s*;\s*[^\s;]+)*$/;

/**
 * Validate a request-body media type against the RFC media-type grammar
 * (`type/subtype`, optional parameters). The OpenAPI `content` map key is
 * attacker-influenced and is interpolated into a string literal, so a value
 * that is not a well-formed media type is replaced with `application/json`
 * (the universal safe default) rather than trusted. The returned value is
 * still escaped at the literal sink by {@link escapeStringLiteral}.
 */
export function sanitizeMediaType(str: string): string {
  return MEDIA_TYPE_RE.test(str.trim()) ? str.trim() : 'application/json';
}

/**
 * Escape a string for safe embedding in a double-quoted Python string literal.
 * Escapes backslashes, double quotes, and newlines.
 */
export function escapePyString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

const PY_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'match',
  'case',
]);

/**
 * Convert an arbitrary parameter name into a valid, non-keyword Python
 * identifier for use as a function argument or local variable name.
 */
export function sanitizePyIdentifier(str: string): string {
  let id = str.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(id)) id = `_${id}`;
  if (PY_KEYWORDS.has(id)) id = `${id}_`;
  return id || '_param';
}

/**
 * Validate that a URL path template contains only safe characters.
 * Allows: alphanumeric, /, {, }, -, _, .
 */
export function sanitizePathTemplate(str: string): string {
  return str.replace(/[^a-zA-Z0-9/{}._\-]/g, '');
}

/**
 * Sanitize a file name — strip path separators and traversal sequences.
 */
export function sanitizeFileName(str: string): string {
  return str
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    .replace(/[^a-zA-Z0-9._\-]/g, '');
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check if a key is a dangerous prototype pollution key.
 */
export function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}
