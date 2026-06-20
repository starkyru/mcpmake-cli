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
 * Sanitize a base URL for safe embedding in a string literal across multiple
 * target languages (TS single/double quote, Python double quote, TOML, .env).
 * A legitimate URL never contains quotes, backticks, backslashes, whitespace,
 * or `${`/`{`/`}` (environment templating uses MCP_ENVIRONMENTS, not literal
 * braces), so stripping those is lossless for real URLs and removes every
 * literal-breakout and template-injection vector.
 */
export function sanitizeUrlLiteral(str: string): string {
  return str.replace(/[\s'"`\\${}]/g, '');
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
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for',
  'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case',
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
