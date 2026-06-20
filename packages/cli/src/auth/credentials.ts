/**
 * Local CLI credential storage for `mcpmake login`.
 *
 * A single active credential is kept in `~/.mcpmake/credentials.json` with 0600
 * permissions (owner read/write only). It holds the backend URL, a per-user
 * deploy token (`mfd_…` — never the account password, never an admin token), and
 * the account email for display. `MCPMAKE_DEPLOY_TOKEN` (and `MCPMAKE_SERVER`)
 * env vars override the file for CI / headless use.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';

export interface Credentials {
  serverUrl: string;
  token: string;
  email?: string;
}

/** Config dir: `$MCPMAKE_CONFIG_DIR` if set (handy for CI / tests), else
 *  `~/.mcpmake`. Read lazily so an env override applies without re-import. */
function configDir(): string {
  return process.env.MCPMAKE_CONFIG_DIR || join(homedir(), '.mcpmake');
}

export function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}

/** Shaped like a deploy token (cheap pre-check; the server is authoritative). */
export function looksLikeDeployToken(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.startsWith('mfd_');
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(credentialsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (
      parsed &&
      typeof parsed.serverUrl === 'string' &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return {
        serverUrl: parsed.serverUrl,
        token: parsed.token,
        email: typeof parsed.email === 'string' ? parsed.email : undefined,
      };
    }
    return null;
  } catch {
    return null; // missing / unreadable / malformed → treated as logged out
  }
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  const file = credentialsPath();
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  // Tighten perms even if the file pre-existed with a looser mode.
  await chmod(file, 0o600).catch(() => {});
}

export async function clearCredentials(): Promise<void> {
  await rm(credentialsPath(), { force: true });
}

/**
 * Resolve the deploy token to use for a request, in precedence order:
 *   1. an explicit `--token` flag,
 *   2. the `MCPMAKE_DEPLOY_TOKEN` env var (CI / headless),
 *   3. the stored credential — but only when it targets the same backend, so a
 *      token minted for one server is never sent to another.
 */
export function resolveDeployToken(opts: {
  explicit?: string;
  serverUrl: string;
  stored: Credentials | null;
}): string | undefined {
  if (opts.explicit) return opts.explicit;
  const env = process.env.MCPMAKE_DEPLOY_TOKEN;
  if (env) return env;
  if (opts.stored && opts.stored.serverUrl === opts.serverUrl) return opts.stored.token;
  return undefined;
}
