/**
 * Sprint E3 — `verify` end-to-end (chained flow).
 *
 * Each test first GENERATES a real project with `from openapi` into a subdir of
 * the sandbox, then runs `verify` against that emitted project. This exercises
 * the full bin shim + citty parsing + real exit codes + on-disk drift detection
 * that the in-process unit tier (verify.test.ts, which calls run() directly)
 * cannot cover.
 *
 * Hand-written contract for the petstore fixture (4 distinct operationIds, no
 * name collisions). These slugs are the contract a naming/dedup regression must
 * break — they are NOT recomputed via buildAllTools.
 */

import { rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { E2E } from './helpers/gating.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Canonical 4-operation petstore lives in the shared CLI fixtures dir. */
const PETSTORE = resolve(__dirname, '..', 'fixtures', 'petstore.yaml');

/** The petstore yields exactly four tools (one per operationId). */
const EXPECTED_TOOL_COUNT = 4;
const EXPECTED_TOOL_FILES = ['list-pets', 'create-pet', 'show-pet-by-id', 'delete-pet'] as const;

/** Generate a standard (per-tool-file) petstore project at `<sandbox>/proj`. */
async function generatePetstore(sandbox: string, spec = PETSTORE): Promise<string> {
  const projDir = resolve(sandbox, 'proj');
  const gen = await runCli(['from', 'openapi', spec, '-o', projDir], { cwd: sandbox });
  expect(gen.code, combined(gen)).toBe(0);
  expect(combined(gen)).toContain('Found 4 operations');
  return projDir;
}

describe.skipIf(!E2E)('e2e verify: drift detection on a generated project', () => {
  beforeAll(() => ensureBuilt());

  it('verifies a freshly generated project: exit 0, "all 4 tools match the spec"', async () => {
    await withTempDir(async (sandbox) => {
      const proj = await generatePetstore(sandbox);

      const r = await runCli(['verify', PETSTORE, '-p', proj], { cwd: sandbox });
      expect(r.code).toBe(0);
      const out = combined(r);
      // Exact success message including the exact tool count.
      expect(out).toContain(`Verified: all ${EXPECTED_TOOL_COUNT} tools match the spec`);
    });
  });

  it('exit 1 + "Missing tool file" when an expected tool file is deleted', async () => {
    await withTempDir(async (sandbox) => {
      const proj = await generatePetstore(sandbox);

      // Delete one tool file the spec still requires.
      await rm(resolve(proj, 'src/tools/show-pet-by-id.ts'));

      const r = await runCli(['verify', PETSTORE, '-p', proj], { cwd: sandbox });
      expect(r.code).toBe(1);
      const out = combined(r);
      expect(out).toContain('Missing tool file: src/tools/show-pet-by-id.ts');
      expect(out).toContain('Verification failed: 1 missing, 0 extra tools');
    });
  });

  it('exit 1 + "Extra tool not in spec" when the index registers a foreign tool', async () => {
    await withTempDir(async (sandbox) => {
      const proj = await generatePetstore(sandbox);

      // verify scans the *index's* `from './<fileName>.js'` imports (not the raw
      // tools dir), so a stray tool is only "extra" once it's both on disk AND
      // imported by index.ts. Add both to model a real foreign registration.
      const indexPath = resolve(proj, 'src/tools/index.ts');
      const index = await readFile(indexPath, 'utf-8');
      expect(EXPECTED_TOOL_FILES as readonly string[]).not.toContain('ghost-tool');
      await writeFile(
        resolve(proj, 'src/tools/ghost-tool.ts'),
        'export const register = () => {};\n',
      );
      await writeFile(
        indexPath,
        `import { register as registerGhostTool } from './ghost-tool.js';\n${index}`,
      );

      const r = await runCli(['verify', PETSTORE, '-p', proj], { cwd: sandbox });
      expect(r.code).toBe(1);
      const out = combined(r);
      expect(out).toContain('Extra tool not in spec: src/tools/ghost-tool.ts');
      expect(out).toContain('Verification failed: 0 missing, 1 extra tools');
    });
  });

  it('verifies a dynamic-discovery project via tool-catalog.json: exit 0, "(dynamic discovery)"', async () => {
    await withTempDir(async (sandbox) => {
      const proj = resolve(sandbox, 'dyn');
      const gen = await runCli(['from', 'openapi', PETSTORE, '-o', proj, '--dynamic-discovery'], {
        cwd: sandbox,
      });
      expect(gen.code, combined(gen)).toBe(0);

      const r = await runCli(['verify', PETSTORE, '-p', proj], { cwd: sandbox });
      expect(r.code).toBe(0);
      // Catalog branch emits a distinct success suffix.
      expect(combined(r)).toContain(
        `Verified: all ${EXPECTED_TOOL_COUNT} tools match the spec (dynamic discovery)`,
      );
    });
  });

  it('exit 1 + "Missing tool in catalog" when a catalog entry is removed', async () => {
    await withTempDir(async (sandbox) => {
      const proj = resolve(sandbox, 'dyn');
      const gen = await runCli(['from', 'openapi', PETSTORE, '-o', proj, '--dynamic-discovery'], {
        cwd: sandbox,
      });
      expect(gen.code, combined(gen)).toBe(0);

      // Drop the first catalog entry (list_pets) so verify sees one tool missing.
      const catalogPath = resolve(proj, 'src/tool-catalog.json');
      const catalog = JSON.parse(await readFile(catalogPath, 'utf-8')) as { name: string }[];
      expect(catalog).toHaveLength(EXPECTED_TOOL_COUNT);
      expect(catalog[0].name).toBe('list_pets');
      await writeFile(catalogPath, JSON.stringify(catalog.slice(1), null, 2));

      const r = await runCli(['verify', PETSTORE, '-p', proj], { cwd: sandbox });
      expect(r.code).toBe(1);
      const out = combined(r);
      expect(out).toContain('Missing tool in catalog: list_pets');
      expect(out).toContain('Verification failed: 1 missing, 0 extra tools');
    });
  });

  it('exit 1 + "Extra tool not in spec" when the catalog lists a foreign tool', async () => {
    await withTempDir(async (sandbox) => {
      const proj = resolve(sandbox, 'dyn');
      const gen = await runCli(['from', 'openapi', PETSTORE, '-o', proj, '--dynamic-discovery'], {
        cwd: sandbox,
      });
      expect(gen.code, combined(gen)).toBe(0);

      // Append a catalog entry whose name is NOT one of the spec's four tools.
      const catalogPath = resolve(proj, 'src/tool-catalog.json');
      const catalog = JSON.parse(await readFile(catalogPath, 'utf-8')) as { name: string }[];
      expect(catalog.map((e) => e.name)).not.toContain('ghost_tool');
      catalog.push({ name: 'ghost_tool' });
      await writeFile(catalogPath, JSON.stringify(catalog, null, 2));

      const r = await runCli(['verify', PETSTORE, '-p', proj], { cwd: sandbox });
      expect(r.code).toBe(1);
      const out = combined(r);
      expect(out).toContain('Extra tool not in spec: ghost_tool');
      expect(out).toContain('Verification failed: 0 missing, 1 extra tools');
    });
  });
});
