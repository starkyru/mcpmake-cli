import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathExists } from '@mcpmake/core';
import testScaffoldCommand from '../../src/commands/test-scaffold.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const SPEC = resolve(FIXTURES, 'petstore.yaml');

function spyOnExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
}

describe('test-scaffold command', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(resolve(tmpdir(), 'mcpmake-scaffold-'));
  });
  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('emits test/smoke.test.ts with the resolvable read-only case and a chained flow', async () => {
    const exitSpy = spyOnExit();
    await expect(
      testScaffoldCommand.run!({ args: { spec: SPEC, project } } as never),
    ).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();

    const outPath = resolve(project, 'test/smoke.test.ts');
    expect(await pathExists(outPath)).toBe(true);
    const content = await readFile(outPath, 'utf-8');

    // No unrendered template tokens leaked into the emitted file.
    expect(content).not.toContain('{{');
    // Framework + runtime scaffolding present.
    expect(content).toContain("from 'vitest'");
    expect(content).toContain('functional smoke');
    expect(content).toContain('SMOKE_BASE_URL');
    // The spec base URL is baked as the fallback.
    expect(content).toContain('https://petstore.swagger.io/v1');

    // listPets is the one resolvable read-only case (GET /pets, no required params).
    expect(content).toContain('"name":"listPets"');
    // showPetById is NOT a standalone case (its {petId} has no example) — it must
    // only appear as the chain's item op, keyed "itemName", never as a case "name".
    expect(content).not.toContain('"name":"showPetById"');
    expect(content).toContain('"itemName":"showPetById"');
    // Write ops never appear in a read-only suite.
    expect(content).not.toContain('createPet');
    expect(content).not.toContain('deletePet');
  });

  it('refuses to overwrite an existing suite without --force, and replaces it with --force', async () => {
    // First write succeeds.
    const exit1 = spyOnExit();
    await testScaffoldCommand.run!({ args: { spec: SPEC, project } } as never);
    exit1.mockRestore();

    // Second write without --force must fail (exit 1) and leave the file intact.
    const exit2 = spyOnExit();
    await expect(
      testScaffoldCommand.run!({ args: { spec: SPEC, project } } as never),
    ).rejects.toThrow('process.exit called');
    expect(exit2).toHaveBeenCalledWith(1);
    exit2.mockRestore();

    // With --force it succeeds.
    const exit3 = spyOnExit();
    await expect(
      testScaffoldCommand.run!({ args: { spec: SPEC, project, force: true } } as never),
    ).resolves.toBeUndefined();
    expect(exit3).not.toHaveBeenCalled();
  });
});
