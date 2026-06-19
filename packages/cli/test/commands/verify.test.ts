import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { detectAuthSchemes } from '@mcpmake/core';
import { emitProject } from '@mcpmake/core';
import { pathExists } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';

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
});
