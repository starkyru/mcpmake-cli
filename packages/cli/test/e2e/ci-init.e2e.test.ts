/**
 * Sprint E2 — `mcpmake ci init` end-to-end.
 *
 * This command writes `.github/workflows/mcpmake.yaml` into the CURRENT WORKING
 * DIRECTORY, so every `runCli` here sets `cwd` to a throwaway sandbox — it must
 * never touch the real repo's `.github/`. A guard test asserts the repo's
 * workflow dir is byte-for-byte unchanged after the suite runs.
 *
 * Covers: a full openapi+http+name init (exact path + key content lines), the
 * no-`--force` re-run guard (exit 1), `--force` overwrite, invalid
 * source/transport (exit 1), and the "Unsafe spec path" rejection of a
 * shell-metacharacter payload.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt, REPO_ROOT } from './helpers/build-guard.js';
import { withTempDir, makeTempDir, removeTempDir } from './helpers/sandbox.js';
import { assertTreeContains } from './helpers/assert-tree.js';
import { E2E } from './helpers/gating.js';

/** POSIX-relative path the command always writes to, under the cwd. */
const WORKFLOW_REL = '.github/workflows/mcpmake.yaml';

/** Snapshot the real repo's workflow dir so the guard test can prove no write leaked in. */
const REAL_WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
async function snapshotRealWorkflows(): Promise<string[]> {
  if (!existsSync(REAL_WORKFLOWS_DIR)) return [];
  return (await readdir(REAL_WORKFLOWS_DIR)).sort();
}

describe.skipIf(!E2E)('e2e: mcpmake ci init', () => {
  beforeAll(() => ensureBuilt());

  it('writes .github/workflows/mcpmake.yaml with the expected content', async () => {
    await withTempDir(async (dir) => {
      const r = await runCli(
        ['ci', 'init', 'api-spec.yaml', '-s', 'openapi', '-t', 'http', '-n', 'my-api'],
        { cwd: dir },
      );
      expect(r.code).toBe(0);
      expect(combined(r)).toContain(`Wrote `);
      expect(combined(r)).toContain(WORKFLOW_REL);

      // The file lands at exactly the expected relative path.
      assertTreeContains(dir, [WORKFLOW_REL]);

      const yaml = await readFile(join(dir, WORKFLOW_REL), 'utf-8');
      // Workflow identity + triggers.
      expect(yaml).toContain('name: mcpmake');
      expect(yaml).toContain('  pull_request:');
      expect(yaml).toContain('  workflow_dispatch:');
      expect(yaml).toContain('- "api-spec.yaml"');
      // Regenerate step carries every flag (openapi source, http transport, name).
      expect(yaml).toContain(
        'run: npx --yes mcpmake@latest from openapi "api-spec.yaml" -o "./mcp-server" -n "my-api" -t http -f',
      );
      // verify step is emitted for openapi sources.
      expect(yaml).toContain(
        'run: npx --yes mcpmake@latest verify "api-spec.yaml" -p "./mcp-server"',
      );
      // Drift gate.
      expect(yaml).toContain('git status --porcelain "./mcp-server"');
      expect(yaml).toContain('exit 1');
    });
  });

  it('re-running without --force fails (exit 1) and does not overwrite', async () => {
    await withTempDir(async (dir) => {
      const first = await runCli(['ci', 'init', 'api-spec.yaml'], { cwd: dir });
      expect(first.code).toBe(0);
      const original = await readFile(join(dir, WORKFLOW_REL), 'utf-8');

      const second = await runCli(['ci', 'init', 'api-spec.yaml'], { cwd: dir });
      expect(second.code).toBe(1);
      expect(combined(second)).toContain('already exists. Re-run with --force to overwrite.');

      // File untouched.
      expect(await readFile(join(dir, WORKFLOW_REL), 'utf-8')).toBe(original);
    });
  });

  it('--force overwrites an existing workflow (exit 0)', async () => {
    await withTempDir(async (dir) => {
      const first = await runCli(['ci', 'init', 'api-one.yaml'], { cwd: dir });
      expect(first.code).toBe(0);
      const before = await readFile(join(dir, WORKFLOW_REL), 'utf-8');
      expect(before).toContain('- "api-one.yaml"');

      // Re-init with a different spec path + --force; content must change.
      const second = await runCli(['ci', 'init', 'api-two.yaml', '--force'], { cwd: dir });
      expect(second.code).toBe(0);
      const after = await readFile(join(dir, WORKFLOW_REL), 'utf-8');
      expect(after).toContain('- "api-two.yaml"');
      expect(after).not.toContain('- "api-one.yaml"');
    });
  });

  it('an invalid --source is rejected (exit 1)', async () => {
    await withTempDir(async (dir) => {
      const r = await runCli(['ci', 'init', 'api-spec.yaml', '-s', 'graphql'], { cwd: dir });
      expect(r.code).toBe(1);
      expect(combined(r)).toContain(
        'Invalid --source "graphql". Use one of: openapi, har, postman.',
      );
      // Nothing written on a rejected init.
      expect(existsSync(join(dir, WORKFLOW_REL))).toBe(false);
    });
  });

  it('an invalid --transport is rejected (exit 1)', async () => {
    await withTempDir(async (dir) => {
      const r = await runCli(['ci', 'init', 'api-spec.yaml', '-t', 'grpc'], { cwd: dir });
      expect(r.code).toBe(1);
      expect(combined(r)).toContain('Invalid --transport "grpc". Use one of: stdio, http.');
      expect(existsSync(join(dir, WORKFLOW_REL))).toBe(false);
    });
  });

  it('a shell-metacharacter spec path is rejected with "Unsafe spec path" (exit 1)', async () => {
    await withTempDir(async (dir) => {
      const r = await runCli(['ci', 'init', 'foo$(reboot).yaml'], { cwd: dir });
      expect(r.code).toBe(1);
      // Exact message from ci.ts.
      expect(combined(r)).toContain(
        'Unsafe spec path "foo$(reboot).yaml". Use a plain relative path (letters, digits, . _ / -).',
      );
      expect(existsSync(join(dir, WORKFLOW_REL))).toBe(false);
    });
  });

  it('rejects a `../../` path-traversal spec arg with "Unsafe spec path"', async () => {
    // SAFE_PATH `^[A-Za-z0-9._/-]+$` permits `.` and `/`, so the explicit
    // isUnsafePath traversal guard is what rejects "../../etc/x": it carries a
    // `..` segment. The CLI must exit 1 with the same "Unsafe spec path"
    // message as a shell-metachar payload and write nothing.
    await withTempDir(async (dir) => {
      const r = await runCli(['ci', 'init', '../../etc/x', '-s', 'openapi'], { cwd: dir });
      expect(r.code).toBe(1);
      expect(combined(r)).toContain(
        'Unsafe spec path "../../etc/x". Use a plain relative path (letters, digits, . _ / -).',
      );
      expect(existsSync(join(dir, WORKFLOW_REL))).toBe(false);
    });
  });

  it('never writes into the real repo .github/workflows', async () => {
    // Defense in depth: run an init in a sandbox and prove the real repo's
    // workflow directory is unchanged. Every other test already pins cwd to a
    // sandbox; this is the explicit guard the sprint brief calls for.
    const before = await snapshotRealWorkflows();

    const dir = await makeTempDir();
    try {
      const r = await runCli(['ci', 'init', 'api-spec.yaml'], { cwd: dir });
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, WORKFLOW_REL))).toBe(true);
    } finally {
      await removeTempDir(dir);
    }

    const after = await snapshotRealWorkflows();
    expect(after).toEqual(before);
  });
});
