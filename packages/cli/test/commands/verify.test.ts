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

describe('verify command logic', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-verify-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('generated project has all expected tool files', async () => {
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
      { outputDir, force: true, dryRun: false },
    );

    // Every expected tool file should exist
    for (const tool of tools) {
      const toolPath = resolve(outputDir, `src/tools/${tool.fileName}.ts`);
      expect(await pathExists(toolPath), `${tool.fileName}.ts should exist`).toBe(true);
    }

    // Tool index should exist
    expect(await pathExists(resolve(outputDir, 'src/tools/index.ts'))).toBe(true);
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

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
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
    await writeFile(catalogPath, JSON.stringify(catalog.slice(1), null, 2));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
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
