/**
 * Sprint E5 — `mcpmake from openapi` LLM/deterministic tool-naming, end-to-end.
 *
 * Three naming paths over the committed petstore fixture, spawned through the
 * built bin:
 *   1. `--improve-names` with NO provider → warns and falls back to the
 *      deterministic default operationId-derived names (no crash, exit 0).
 *   2. `--improve-names` WITH the loopback mock (see helpers/mock-llm.ts) → the
 *      improved names from the canned completion appear as the emitted tool
 *      files.
 *   3. `--resource-names` (offline, no key/server) → deterministic REST
 *      resource-tree names, derived from method+path.
 *
 * The default petstore operationIds emit these tool files:
 *   listPets→list-pets, createPet→create-pet, showPetById→show-pet-by-id,
 *   deletePet→delete-pet.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { E2E } from './helpers/gating.js';
import { startMockLlm, mockLlmEnv, type MockLlm } from './helpers/mock-llm.js';

/** Committed OpenAPI fixture (4 operations: list/create/show/delete pet). */
const SPEC = fileURLToPath(new URL('../fixtures/petstore.yaml', import.meta.url));

/** Tool files from the petstore's default operationIds (no naming pass). */
const DEFAULT_TOOL_FILES = [
  'create-pet.ts',
  'delete-pet.ts',
  'index.ts',
  'list-pets.ts',
  'show-pet-by-id.ts',
];

/** Sorted list of files in <out>/src/tools, for an exact on-disk assertion. */
function toolFiles(out: string): string[] {
  const dir = join(out, 'src', 'tools');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe.skipIf(!E2E)('e2e: from openapi tool naming (improve-names / resource-names)', () => {
  let mock: MockLlm | undefined;

  beforeAll(() => ensureBuilt());

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = undefined;
    }
  });

  it('--improve-names with no provider warns and falls back to default names (exit 0)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      // No mockLlmEnv merged → no usable provider.
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--improve-names'], { cwd: dir });

      // The optional AI step degrades gracefully: it must NOT crash the run.
      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Found 4 operations');
      // Exact warning from improveToolNames when getLlmProvider() returns null.
      expect(text).toContain('No LLM provider configured — skipping LLM tool naming');

      // Tools are still generated, using the deterministic default names.
      expect(toolFiles(out)).toEqual(DEFAULT_TOOL_FILES);
    });
  });

  it('--improve-names with the mock writes the improved names to the tool files', async () => {
    mock = await startMockLlm();
    // The naming response matches improveToolNames' NAMING_SCHEMA: one entry per
    // operation, zero-based `index`, a camelCase `operationId`, and a `summary`.
    // Petstore order is list/create/show/delete pet (spec path order).
    mock.setChatContent(
      JSON.stringify({
        improvements: [
          { index: 0, operationId: 'fetchAllPets', summary: 'Fetch every pet' },
          { index: 1, operationId: 'addNewPet', summary: 'Add a new pet' },
          { index: 2, operationId: 'fetchPetDetail', summary: 'Fetch one pet' },
          { index: 3, operationId: 'removePet', summary: 'Remove a pet' },
        ],
      }),
    );

    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--improve-names'], {
        cwd: dir,
        env: mockLlmEnv(mock!),
      });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Improving tool names with openai...');
      expect(text).toContain('Improved 4 tool names');

      // The improved operationIds become the emitted tool filenames (kebab-case).
      expect(toolFiles(out)).toEqual([
        'add-new-pet.ts',
        'fetch-all-pets.ts',
        'fetch-pet-detail.ts',
        'index.ts',
        'remove-pet.ts',
      ]);

      // Exactly one chat completion was served (the single naming call).
      expect(mock!.chatRequests()).toHaveLength(1);
    });
  });

  it('--resource-names renames deterministically from the REST tree (offline, no key)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      // No provider env at all — this path is deterministic and offline.
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--resource-names'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Found 4 operations');
      // No LLM was consulted: the LLM-naming info/warn lines never appear.
      expect(text).not.toContain('Improving tool names');
      expect(text).not.toContain('skipping LLM tool naming');

      // REST resource-tree naming:
      //   GET    /pets         → list_pets
      //   POST   /pets         → create_pet
      //   GET    /pets/{petId} → get_pet   (was showPetById → show-pet-by-id)
      //   DELETE /pets/{petId} → delete_pet
      // The single delta vs the default tree is show-pet-by-id → get-pet.
      expect(toolFiles(out)).toEqual([
        'create-pet.ts',
        'delete-pet.ts',
        'get-pet.ts',
        'index.ts',
        'list-pets.ts',
      ]);
    });
  });
});
