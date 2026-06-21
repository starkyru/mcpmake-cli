/**
 * File-tree assertions for generator e2e tests.
 *
 * `listTree` returns every file path under a dir, relative + POSIX-normalized +
 * sorted, so assertions are stable across platforms. `assertTreeEquals` checks
 * the *exact* set (catches stray or missing files); `assertTreeContains` checks
 * a superset (use when the emitter may add incidental files you don't pin).
 */

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect } from 'vitest';

export interface ListTreeOptions {
  /** Directory names to skip entirely (default: node_modules, .git). */
  ignoreDirs?: string[];
}

/** Recursively collect file paths under `root`, relative + sorted (POSIX slashes). */
export function listTree(root: string, opts: ListTreeOptions = {}): string[] {
  const ignore = new Set(opts.ignoreDirs ?? ['node_modules', '.git']);
  const out: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
      }
    }
  }

  walk(root);
  return out.sort();
}

/** Assert the directory contains exactly `expected` (order-independent). */
export function assertTreeEquals(root: string, expected: string[]): void {
  expect(listTree(root).sort()).toEqual([...expected].sort());
}

/** Assert every path in `expected` exists under `root` (extras allowed). */
export function assertTreeContains(root: string, expected: string[]): void {
  const actual = new Set(listTree(root));
  const missing = expected.filter((p) => !actual.has(p));
  expect(missing, `missing expected files under ${root}`).toEqual([]);
}
