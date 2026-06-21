/**
 * Sprint E3 — `update` end-to-end (chained flow).
 *
 * Each test GENERATES a real petstore project with `from openapi`, then runs
 * `update` against it with a spec variant and asserts the on-disk diff and the
 * structural-change messages.
 *
 * Fixtures used:
 *   - ../fixtures/petstore.yaml          canonical 4 operations (base)
 *   - ./fixtures/petstore-added.yaml     base + getPetStats  → 5 operations
 *   - ./fixtures/petstore-removed.yaml   base - deletePet    → 3 operations
 *
 * Documented behavior under test: update does NOT delete orphan tool files. A
 * removed operation is de-registered from the index but its src/tools/*.ts file
 * is intentionally left on disk (see update.ts: "Removed tools (files may still
 * exist)"). The remove test pins that no-delete contract.
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { listTree } from './helpers/assert-tree.js';
import { E2E } from './helpers/gating.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE = resolve(__dirname, '..', 'fixtures', 'petstore.yaml');
const PETSTORE_ADDED = resolve(__dirname, 'fixtures', 'petstore-added.yaml');
const PETSTORE_REMOVED = resolve(__dirname, 'fixtures', 'petstore-removed.yaml');

/** package.json `name` the generator derives from the petstore title. */
const EXPECTED_PROJECT_NAME = 'swagger-petstore';

async function projectName(projDir: string): Promise<string> {
  const pkg = JSON.parse(await readFile(resolve(projDir, 'package.json'), 'utf-8')) as {
    name: string;
  };
  return pkg.name;
}

/** Generate the canonical 4-operation petstore at `<sandbox>/proj`. */
async function generatePetstore(sandbox: string): Promise<string> {
  const projDir = resolve(sandbox, 'proj');
  const gen = await runCli(['from', 'openapi', PETSTORE, '-o', projDir], { cwd: sandbox });
  expect(gen.code, combined(gen)).toBe(0);
  expect(combined(gen)).toContain('Found 4 operations');
  return projDir;
}

describe.skipIf(!E2E)('e2e update: incremental re-generation of a generated project', () => {
  beforeAll(() => ensureBuilt());

  it('re-running update with the SAME spec reports +0/-0 and "No structural changes"', async () => {
    await withTempDir(async (sandbox) => {
      const proj = await generatePetstore(sandbox);
      expect(await projectName(proj)).toBe(EXPECTED_PROJECT_NAME);

      const r = await runCli(['update', PETSTORE, '-p', proj], { cwd: sandbox });
      expect(r.code).toBe(0);
      const out = combined(r);
      expect(out).toContain('Diff: +0 added, -0 removed, 4 updated');
      expect(out).toContain('No structural changes. Regenerating all tool files to sync schemas.');
      expect(out).toContain('Project updated successfully');

      // package.json name must survive the regen.
      expect(await projectName(proj)).toBe(EXPECTED_PROJECT_NAME);
    });
  });

  it('updating with a spec that ADDS an operation reports +1 and writes the new tool file', async () => {
    await withTempDir(async (sandbox) => {
      const proj = await generatePetstore(sandbox);
      // Pre-condition: the new operation's tool file does NOT yet exist.
      const newToolPath = resolve(proj, 'src/tools/get-pet-stats.ts');
      expect(listTree(proj)).not.toContain('src/tools/get-pet-stats.ts');

      const r = await runCli(['update', PETSTORE_ADDED, '-p', proj], { cwd: sandbox });
      expect(r.code).toBe(0);
      const out = combined(r);
      expect(out).toContain('Diff: +1 added, -0 removed, 4 updated');
      expect(out).toContain('New tools: get_pet_stats');
      expect(out).toContain('Project updated successfully');

      // The new tool file now exists on disk and is registered in the index.
      expect(listTree(proj)).toContain('src/tools/get-pet-stats.ts');
      const index = await readFile(newToolPath, 'utf-8');
      expect(index.length).toBeGreaterThan(0);
      const toolIndex = await readFile(resolve(proj, 'src/tools/index.ts'), 'utf-8');
      expect(toolIndex).toContain(`'./get-pet-stats.js'`);

      // Name preserved across the structural add.
      expect(await projectName(proj)).toBe(EXPECTED_PROJECT_NAME);
    });
  });

  it('updating with a spec that REMOVES an operation reports -1 and LEAVES the orphan file on disk', async () => {
    await withTempDir(async (sandbox) => {
      const proj = await generatePetstore(sandbox);
      const orphanRel = 'src/tools/delete-pet.ts';
      expect(listTree(proj)).toContain(orphanRel);

      const r = await runCli(['update', PETSTORE_REMOVED, '-p', proj], { cwd: sandbox });
      expect(r.code).toBe(0);
      const out = combined(r);
      expect(out).toContain('Diff: +0 added, -1 removed, 3 updated');
      // The warning documents the no-delete behavior explicitly.
      expect(out).toContain('Removed tools (files may still exist): delete-pet');
      expect(out).toContain('Project updated successfully');

      // BEHAVIOR (not a bug): update never deletes orphan tool files. The removed
      // operation's source file persists; only its index registration is dropped.
      expect(listTree(proj)).toContain(orphanRel);
      const toolIndex = await readFile(resolve(proj, 'src/tools/index.ts'), 'utf-8');
      expect(toolIndex).not.toContain(`'./delete-pet.js'`);

      // Name preserved across the structural removal.
      expect(await projectName(proj)).toBe(EXPECTED_PROJECT_NAME);
    });
  });

  it('running update in a non-project dir (no package.json) exits 1 with a clear error', async () => {
    await withTempDir(async (sandbox) => {
      const notProj = resolve(sandbox, 'not-a-project');
      await mkdir(notProj, { recursive: true });

      const r = await runCli(['update', PETSTORE, '-p', notProj], { cwd: sandbox });
      expect(r.code).toBe(1);
      expect(combined(r)).toContain(`Not a valid project directory: ${notProj}`);
    });
  });
});
