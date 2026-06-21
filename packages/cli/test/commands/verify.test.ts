import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { detectAuthSchemes } from '@mcpmake/core';
import { emitProject } from '@mcpmake/core';
import { pathExists } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';
import verifyCommand from '../../src/commands/verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

// Hand-written, independently-derived expectation for the petstore fixture.
// Its four operationIds (listPets/createPet/showPetById/deletePet) are distinct,
// so buildAllTools produces these exact slugs with no collision suffixes. These
// are intentionally NOT recomputed from buildAllTools — they are the contract a
// regression in the naming/dedup logic must break.
const EXPECTED_TOOL_FILES = ['list-pets', 'create-pet', 'show-pet-by-id', 'delete-pet'] as const;
const EXPECTED_TOOL_NAMES = ['list_pets', 'create_pet', 'show_pet_by_id', 'delete_pet'] as const;

/** Mock process.exit so fail()'s exit becomes an observable throw. */
function spyOnExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
}

/** Generate a standard (per-tool-file) petstore project into `dir`. */
async function emitDefaultProject(dir: string): Promise<void> {
  const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
  const { operations, baseUrl, securitySchemes } = extractOperations(api as OpenAPIV3.Document);
  const tools = buildAllTools(operations);
  const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

  await emitProject(
    {
      serverName: 'verify-test',
      transport: 'stdio',
      serverVersion: '1.0.0',
      baseUrl,
      tools,
      authSchemes,
      envVars,
    },
    { outputDir: dir, force: true, dryRun: false },
  );
}

describe('verify command logic', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-verify-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('passes the default per-tool-file path when every tool file is present and registered', async () => {
    await emitDefaultProject(outputDir);

    // Sanity: this is the default (non-catalog) path, so no catalog must exist —
    // otherwise verify would short-circuit to verifyCatalog and this test would
    // not exercise the per-tool-file branch it claims to.
    expect(await pathExists(resolve(outputDir, 'src/tool-catalog.json'))).toBe(false);

    // Pre-condition the assertion depends on: the four expected files exist and
    // the index registers each with the exact `./<fileName>.js` import literal
    // that verify.ts requires (the prefix-substring-proof check at verify.ts:62).
    const indexPath = resolve(outputDir, 'src/tools/index.ts');
    const index = await readFile(indexPath, 'utf-8');
    for (const fileName of EXPECTED_TOOL_FILES) {
      expect(await pathExists(resolve(outputDir, `src/tools/${fileName}.ts`))).toBe(true);
      expect(index).toContain(`'./${fileName}.js'`);
    }
    // Every expected tool name is wired into registerAllTools via isToolEnabled.
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(index).toContain(`isToolEnabled('${name}')`);
    }

    const exitSpy = spyOnExit();
    try {
      await expect(
        verifyCommand.run!({
          args: { spec: resolve(FIXTURES, 'petstore.yaml'), project: outputDir },
        } as never),
      ).resolves.toBeUndefined();
      // Success path must not exit the process.
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails the default path when an expected tool file is missing', async () => {
    await emitDefaultProject(outputDir);

    // Remove one tool file the spec requires. verify must report it missing and exit 1.
    const removed = resolve(outputDir, 'src/tools/show-pet-by-id.ts');
    expect(await pathExists(removed)).toBe(true);
    await rm(removed);
    expect(await pathExists(removed)).toBe(false);

    const exitSpy = spyOnExit();
    try {
      await expect(
        verifyCommand.run!({
          args: { spec: resolve(FIXTURES, 'petstore.yaml'), project: outputDir },
        } as never),
      ).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails the default path when a tool file exists but is not registered in the index', async () => {
    await emitDefaultProject(outputDir);

    // Drop only the import literal for one tool from the index, leaving the file
    // on disk. This drives verify.ts:62 — the exact `'./<fileName>.js'` check.
    // The file still exists, so the bug it guards against (a loose substring
    // match false-passing) would let this slip through; a correct implementation
    // counts it missing and exits 1.
    const indexPath = resolve(outputDir, 'src/tools/index.ts');
    const index = await readFile(indexPath, 'utf-8');
    const importLine = `import { register as registerListPets } from './list-pets.js';`;
    expect(index).toContain(importLine);
    expect(await pathExists(resolve(outputDir, 'src/tools/list-pets.ts'))).toBe(true);
    await writeFile(indexPath, index.replace(`${importLine}\n`, ''));

    const after = await readFile(indexPath, 'utf-8');
    expect(after).not.toContain(`'./list-pets.js'`);

    const exitSpy = spyOnExit();
    try {
      await expect(
        verifyCommand.run!({
          args: { spec: resolve(FIXTURES, 'petstore.yaml'), project: outputDir },
        } as never),
      ).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails the default path when the index registers a tool not in the spec', async () => {
    await emitDefaultProject(outputDir);

    // Add a stray import for a tool the spec does not define. verify.ts scans the
    // index's `from './<fileName>.js'` imports (lines 72-80) and must flag this
    // foreign fileName as "Extra tool not in spec" and exit 1. `ghost-tool` is
    // deliberately NOT one of the spec's expected fileNames.
    expect(EXPECTED_TOOL_FILES as readonly string[]).not.toContain('ghost-tool');
    const indexPath = resolve(outputDir, 'src/tools/index.ts');
    const index = await readFile(indexPath, 'utf-8');
    await writeFile(
      indexPath,
      `import { register as registerGhostTool } from './ghost-tool.js';\n${index}`,
    );

    const exitSpy = spyOnExit();
    try {
      await expect(
        verifyCommand.run!({
          args: { spec: resolve(FIXTURES, 'petstore.yaml'), project: outputDir },
        } as never),
      ).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails the default path when the tool index is absent entirely', async () => {
    await emitDefaultProject(outputDir);

    // No catalog, no index -> verify.ts:47-49 must report the missing index and
    // exit 1 rather than silently "passing" a project with zero discoverable tools.
    expect(await pathExists(resolve(outputDir, 'src/tool-catalog.json'))).toBe(false);
    await rm(resolve(outputDir, 'src/tools/index.ts'));

    const exitSpy = spyOnExit();
    try {
      await expect(
        verifyCommand.run!({
          args: { spec: resolve(FIXTURES, 'petstore.yaml'), project: outputDir },
        } as never),
      ).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('passes verification for a dynamic-discovery project (catalog, no per-tool files)', async () => {
    const specPath = resolve(FIXTURES, 'petstore.yaml');
    const { api } = await loadOpenApiSpec(specPath);
    const { operations, baseUrl, securitySchemes } = extractOperations(api as OpenAPIV3.Document);
    const tools = buildAllTools(operations);
    const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

    await emitProject(
      {
        serverName: 'verify-dynamic',
        transport: 'stdio',
        serverVersion: '1.0.0',
        baseUrl,
        tools,
        authSchemes,
        envVars,
        dynamicDiscovery: true,
      },
      { outputDir, force: true, dryRun: false },
    );

    // Dynamic-discovery emits a catalog instead of per-tool files.
    expect(await pathExists(resolve(outputDir, 'src/tool-catalog.json'))).toBe(true);
    // ...and must NOT emit a per-tool index (otherwise this isn't the catalog path).
    expect(await pathExists(resolve(outputDir, 'src/tools/index.ts'))).toBe(false);

    const exitSpy = spyOnExit();
    try {
      await expect(
        verifyCommand.run!({ args: { spec: specPath, project: outputDir } } as never),
      ).resolves.toBeUndefined();
      // Success path must not exit the process.
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails dynamic-discovery verification when the catalog is missing a tool', async () => {
    const specPath = resolve(FIXTURES, 'petstore.yaml');
    const { api } = await loadOpenApiSpec(specPath);
    const { operations, baseUrl, securitySchemes } = extractOperations(api as OpenAPIV3.Document);
    const tools = buildAllTools(operations);
    const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

    await emitProject(
      {
        serverName: 'verify-dynamic-bad',
        transport: 'stdio',
        serverVersion: '1.0.0',
        baseUrl,
        tools,
        authSchemes,
        envVars,
        dynamicDiscovery: true,
      },
      { outputDir, force: true, dryRun: false },
    );

    // Drop a tool from the catalog so verify sees a mismatch.
    const catalogPath = resolve(outputDir, 'src/tool-catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf-8')) as unknown[];
    expect(catalog.length).toBe(EXPECTED_TOOL_NAMES.length);
    await writeFile(catalogPath, JSON.stringify(catalog.slice(1), null, 2));

    const exitSpy = spyOnExit();
    try {
      await expect(
        verifyCommand.run!({ args: { spec: specPath, project: outputDir } } as never),
      ).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails dynamic-discovery verification when the catalog lists a tool not in the spec', async () => {
    const specPath = resolve(FIXTURES, 'petstore.yaml');
    const { api } = await loadOpenApiSpec(specPath);
    const { operations, baseUrl, securitySchemes } = extractOperations(api as OpenAPIV3.Document);
    const tools = buildAllTools(operations);
    const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

    await emitProject(
      {
        serverName: 'verify-dynamic-extra',
        transport: 'stdio',
        serverVersion: '1.0.0',
        baseUrl,
        tools,
        authSchemes,
        envVars,
        dynamicDiscovery: true,
      },
      { outputDir, force: true, dryRun: false },
    );

    // Append a catalog entry whose name is NOT one of the spec's tools. verify's
    // extra-detection (verifyCatalog, src/commands/verify.ts:124-131) must flag
    // it and exit 1; a missing-only check would false-pass here.
    const catalogPath = resolve(outputDir, 'src/tool-catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf-8')) as { name?: string }[];
    expect(catalog.map((e) => e.name)).not.toContain('ghost_tool');
    catalog.push({ name: 'ghost_tool' });
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2));

    const exitSpy = spyOnExit();
    try {
      await expect(
        verifyCommand.run!({ args: { spec: specPath, project: outputDir } } as never),
      ).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
