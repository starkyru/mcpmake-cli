/**
 * Fail fast (and clearly) when the e2e suite is run against a stale or missing
 * `dist/`. These tests spawn the *built* bin, so they are meaningless without a
 * prior `npm run build`. By default a missing build throws an actionable error;
 * set `MCPMAKE_E2E_AUTOBUILD=1` for a local one-shot build convenience.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** `packages/cli/dist/index.js` — the entrypoint the bin shim imports. */
export const CLI_DIST = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
/** `packages/core/dist/index.js` — the library the CLI resolves at runtime. */
export const CORE_DIST = fileURLToPath(new URL('../../../../core/dist/index.js', import.meta.url));
/** Repo root (four levels up from `packages/cli/test/e2e/helpers`). */
export const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

let checked = false;

/**
 * Ensure both workspace packages are built. Throws with a fix-it message if not
 * (unless `MCPMAKE_E2E_AUTOBUILD=1`, in which case it runs `npm run build`).
 * Memoized so repeated calls across test files are cheap.
 */
export function ensureBuilt(): void {
  if (checked) return;
  const missing = !existsSync(CLI_DIST) || !existsSync(CORE_DIST);
  if (missing) {
    if (process.env.MCPMAKE_E2E_AUTOBUILD === '1') {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    } else {
      throw new Error(
        'E2E suite requires a build. Run `npm run build` first ' +
          '(or set MCPMAKE_E2E_AUTOBUILD=1 to build automatically).\n' +
          `  missing: ${!existsSync(CLI_DIST) ? CLI_DIST : ''} ${!existsSync(CORE_DIST) ? CORE_DIST : ''}`,
      );
    }
  }
  checked = true;
}
