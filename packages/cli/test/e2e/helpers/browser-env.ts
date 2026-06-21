/**
 * Playwright/Chromium provisioning for the browser-crawl e2e tier (Sprint E7).
 *
 * Two problems this solves:
 *
 * 1. `runCli` deliberately scrubs the child env down to an allowlist and sets
 *    `HOME` to the sandbox tmpdir (so credential writes can't escape). But
 *    Playwright resolves its downloaded browser binaries relative to `HOME` (it
 *    looks under `$HOME/Library/Caches/ms-playwright` on macOS,
 *    `$HOME/.cache/ms-playwright` on Linux). With a scrubbed `HOME`, the spawned
 *    CLI can't find the chromium that was installed under the *real* home, and
 *    `browserType.launch` fails with "Executable doesn't exist". We fix this by
 *    pinning `PLAYWRIGHT_BROWSERS_PATH` to the resolved real cache directory and
 *    injecting it into `runCli`'s env (see {@link browserEnv}).
 *
 * 2. CI images may not have chromium downloaded. {@link ensureChromium} attempts
 *    a one-shot `playwright install chromium` in `beforeAll`; if it fails
 *    (offline) it returns `false` so the suite can SKIP cleanly rather than fail.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root — four levels up from `packages/cli/test/e2e/helpers`. */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Resolve the directory Playwright stores downloaded browsers in. Honors an
 * explicit `PLAYWRIGHT_BROWSERS_PATH` if the dev/CI shell already sets one;
 * otherwise uses the OS-specific default location.
 */
export function playwrightBrowsersPath(): string {
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (explicit) return explicit;
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Caches', 'ms-playwright');
    case 'win32':
      return join(home, 'AppData', 'Local', 'ms-playwright');
    default:
      return join(home, '.cache', 'ms-playwright');
  }
}

/** True when at least one `chromium-*` build directory exists in the cache. */
function chromiumPresent(): boolean {
  const dir = playwrightBrowsersPath();
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((name) => name.startsWith('chromium'));
  } catch {
    return false;
  }
}

let provisioned: boolean | undefined;

/**
 * Ensure a chromium build is available, downloading it once if needed.
 *
 * Returns `true` when chromium is present (already, or after a successful
 * install), `false` when it could not be provisioned (e.g. the runner is
 * offline). Callers SKIP the suite on `false` rather than failing — the real
 * crawl runs in nightly CI where the download succeeds. Memoized so repeated
 * `beforeAll`s across files don't re-attempt the download.
 */
export function ensureChromium(): boolean {
  if (provisioned !== undefined) return provisioned;
  if (chromiumPresent()) {
    provisioned = true;
    return true;
  }
  try {
    // `npx playwright install chromium` downloads ~150MB; allow generous time.
    execFileSync('npx', ['playwright', 'install', 'chromium'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      timeout: 300_000,
    });
    provisioned = chromiumPresent();
  } catch {
    provisioned = false;
  }
  return provisioned;
}

/**
 * Env additions a browser-driven `runCli` call must merge so the scrubbed-`HOME`
 * child can (a) find the chromium binaries and (b) pass the SSRF guard for the
 * loopback static site. Merge into `runCli`'s `opts.env`.
 */
export function browserEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
    MCPMAKE_ALLOW_PRIVATE_HOSTS: '1',
    ...extra,
  };
}
