/**
 * Shared CLI helper functions used across the `from/*` import commands and the
 * `rescan` command. These were previously copy-pasted into each command module;
 * keeping a single canonical implementation here avoids drift.
 */

/**
 * Derive a package/server name from an arbitrary human-readable string (an API
 * title, hostname, collection name, …). Lowercases the input, collapses every
 * run of non-`[a-z0-9]` characters into a single `-`, and trims leading/trailing
 * dashes. For example `"My API v2!"` → `"my-api-v2"` and `"api.example.com"` →
 * `"api-example-com"`.
 */
export function toPackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse a numeric CLI flag as a non-negative integer. Unlike a bare
 * `parseInt`, this rejects non-numeric / negative / non-integer input with a
 * clear error instead of silently coercing it to `NaN`→0 (which would zero out
 * scope, e.g. `--max-pages abc` crawling nothing). An unset or empty flag
 * (`undefined` / `''`) falls back to `fallback`.
 *
 * @param value    The raw flag value as parsed from argv, or `undefined`.
 * @param flag     The flag name (without leading `--`), used in error messages.
 * @param fallback The value returned when `value` is `undefined` or empty.
 * @throws Error when `value` is present but not a non-negative integer.
 */
export function parseIntFlag(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid --${flag}: "${value}" (expected a non-negative integer)`);
  }
  return n;
}
