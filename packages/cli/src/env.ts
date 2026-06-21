import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '@mcpmake/core';

/**
 * Trust-boundary denylist for the `.env` autoloader.
 *
 * `loadDotEnv` reads a `.env` file from the *current working directory*, which in
 * practice is an arbitrary, possibly-untrusted checkout (you `cd` into a repo and
 * run `mcpmake`). The file's legitimate job is to supply LLM API keys
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) for local use — NOT to reconfigure the
 * process or where credentials live. Without filtering, a hostile `.env` could:
 *   - set `NODE_OPTIONS=--require=/evil.js` (or other `NODE_*`/loader vars) which
 *     would be inherited by the `npm`/Node children we spawn ⇒ code execution;
 *   - set `MCPMAKE_CONFIG_DIR` to redirect where login credentials are read/written;
 *   - set `MCPMAKE_SERVER` to redirect pricing + opted-in telemetry;
 *   - set `MCPMAKE_LLM_PROVIDER` / `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` to
 *     reroute an already-exported API key + prompts to an attacker endpoint.
 *
 * So these keys are NEVER honored from the *file*. The corresponding shell var
 * still works (only the file is restricted) — see `loadDotEnv` (shell wins).
 */
const DENIED_ENV_KEYS = new Set(
  [
    'NODE_OPTIONS',
    'NODE_PATH',
    'MCPMAKE_CONFIG_DIR',
    'MCPMAKE_SERVER',
    'MCPMAKE_DEPLOY_TOKEN',
    'MCPMAKE_INSECURE',
    'MCPMAKE_ALLOW_PRIVATE_HOSTS',
    'MCPMAKE_LLM_PROVIDER',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
  ].map((k) => k.toUpperCase()),
);

/**
 * Pattern denylist — defense against new/unknown variants of the categories
 * above (loader vars, credential redirects, base-URL reroutes). Matched
 * case-insensitively, like the exact set.
 */
const DENIED_ENV_PATTERNS: RegExp[] = [
  /^NODE_/, // loader / runtime knobs (NODE_OPTIONS, NODE_PATH, …)
  /^DYLD_/, // macOS dynamic-linker injection (DYLD_INSERT_LIBRARIES, …)
  /^LD_/, // Linux dynamic-linker injection (LD_PRELOAD, …)
  /_TOKEN$/, // any credential token
  /_BASE_URL$/, // any provider endpoint reroute
  /CONFIG_DIR$/, // any credential/config path redirect
];

/**
 * True if `key` must NOT be imported from a project `.env`. Case-insensitive.
 * Exported for unit testing and reuse.
 */
export function isDeniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (DENIED_ENV_KEYS.has(upper)) return true;
  return DENIED_ENV_PATTERNS.some((re) => re.test(upper));
}

/**
 * Process-control vars that change how a *child* process executes. We strip
 * these from the env we hand to spawned `npm`/Node so a value that slipped in
 * via the real shell (or anywhere else) can't turn an `npm install` into code
 * execution. `.env` already can't set them (see `isDeniedEnvKey`); this is
 * defense in depth for the child boundary.
 */
function isChildUnsafeEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === 'NODE_OPTIONS' ||
    upper === 'NODE_PATH' ||
    upper.startsWith('LD_') ||
    upper.startsWith('DYLD_')
  );
}

/**
 * Return a shallow copy of `base` (defaults to `process.env`) with the
 * process-control vars that alter child execution removed. Pass the result as
 * the `env` option to internal `execFile`/`spawn` calls that don't need them.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (isChildUnsafeEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Minimal, dependency-free `.env` loader. Reads `<cwd>/.env` if present and
 * sets only the keys NOT already present in `process.env` — an exported shell
 * variable always wins over the file, so this can never clobber a real secret.
 *
 * Process-control and credential-path keys (see `isDeniedEnvKey`) are NEVER
 * loaded from the file: the `.env` lives in an untrusted checkout and must not
 * be able to redirect process execution or credential storage.
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

  let denied = 0;

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

    // Trust boundary: never let a project `.env` set process-control or
    // credential-path keys (see DENIED_ENV_KEYS rationale).
    if (isDeniedEnvKey(key)) {
      denied++;
      continue;
    }

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

  if (denied > 0) {
    logger.warn(
      `Ignored ${denied} process-control/credential ${denied === 1 ? 'key' : 'keys'} from .env; ` +
        'set them in your shell or use --env-file.',
    );
  }
}
