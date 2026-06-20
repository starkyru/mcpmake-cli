import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal, dependency-free `.env` loader. Reads `<cwd>/.env` if present and
 * sets only the keys NOT already present in `process.env` — an exported shell
 * variable always wins over the file, so this can never clobber a real secret.
 *
 * Best-effort: a missing/unreadable file is a silent no-op, and a malformed
 * line is skipped rather than throwing. Supports `KEY=VALUE`, `#` comments,
 * blank lines, optional `export ` prefix, and a single layer of surrounding
 * single/double quotes.
 */
export function loadDotEnv(cwd: string = process.cwd()): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(cwd, '.env'), 'utf8');
  } catch {
    return; // no .env (or unreadable) — fine
  }

  // Split on both LF and CRLF so Windows line endings never leave a stray
  // trailing `\r` clinging to a value (e.g. `KEY="value"\r\n`). The extra
  // `replace` strips any trailing `\r` not consumed by the split
  // (belt-and-suspenders). Bare `\r` (classic Mac OS 9) terminators are not
  // split on and remain unsupported.
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
