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
