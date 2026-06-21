/**
 * Disposable filesystem sandboxes for e2e tests.
 *
 * Every test that writes files (generators, login credential writes, ci-init,
 * bundle, …) runs inside a fresh `mcpmake-e2e-*` tmpdir so it never touches the
 * real repo or the developer's `~/.mcpmake`. `withTempDir` guarantees cleanup
 * via `finally`; a `process.on('exit')` sweeper is a backstop for the rare case
 * a dir leaks (e.g. the runner is hard-killed mid-test).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'mcpmake-e2e-';

/** Dirs still alive — swept synchronously on process exit as a leak backstop. */
const live = new Set<string>();

let sweeperInstalled = false;
function installSweeper(): void {
  if (sweeperInstalled) return;
  sweeperInstalled = true;
  process.on('exit', () => {
    for (const dir of live) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: process is exiting; nothing else we can do.
      }
    }
  });
}

/** Create a fresh sandbox dir. Caller is responsible for removal (prefer `withTempDir`). */
export async function makeTempDir(): Promise<string> {
  installSweeper();
  const dir = await mkdtemp(join(tmpdir(), PREFIX));
  live.add(dir);
  return dir;
}

/** Remove a sandbox dir created by {@link makeTempDir}. Idempotent. */
export async function removeTempDir(dir: string): Promise<void> {
  live.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Run `fn` with a fresh sandbox dir, removing it afterwards even if `fn` throws.
 * Returns whatever `fn` returns.
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await removeTempDir(dir);
  }
}
