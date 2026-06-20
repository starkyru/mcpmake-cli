import { defineCommand } from 'citty';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { pathExists } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';

export default defineCommand({
  meta: {
    name: 'verify',
    description: 'Verify that a generated MCP server still matches its source spec',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Path to the OpenAPI spec',
      required: true,
    },
    project: {
      type: 'string',
      alias: 'p',
      description: 'Path to the generated project directory',
      required: true,
    },
  },
  async run({ args }) {
    logger.info(`Verifying project against spec: ${args.spec}`);

    // Load and parse the spec
    const { api } = await loadOpenApiSpec(args.spec);
    const { operations } = extractOperations(api as OpenAPIV3.Document);
    const expectedTools = buildAllTools(operations);

    // Dynamic-discovery projects emit a single tool-catalog.json instead of
    // per-tool files, so verify against the catalog rather than tool files.
    const catalogPath = resolve(args.project, 'src/tool-catalog.json');
    if (await pathExists(catalogPath)) {
      return await verifyCatalog(catalogPath, expectedTools);
    }

    // Read the generated tool index to find registered tools
    const toolIndexPath = resolve(args.project, 'src/tools/index.ts');
    if (!(await pathExists(toolIndexPath))) {
      await fail(`Tool index not found at: ${toolIndexPath}`);
    }

    const toolIndex = await readFile(toolIndexPath, 'utf-8');

    let missingCount = 0;
    let extraCount = 0;

    // Check each expected tool has a file
    for (const tool of expectedTools) {
      const toolFile = resolve(args.project, `src/tools/${tool.fileName}.ts`);
      if (!(await pathExists(toolFile))) {
        logger.error(`Missing tool file: src/tools/${tool.fileName}.ts (${tool.name})`);
        missingCount++;
      } else if (!toolIndex.includes(tool.fileName)) {
        logger.warn(`Tool file exists but not registered: ${tool.fileName}`);
        missingCount++;
      }
    }

    // Check for extra tool files not in the spec
    const expectedFileNames = new Set(expectedTools.map((t) => t.fileName));
    const importMatches = toolIndex.matchAll(/from '\.\/([^']+)\.js'/g);
    for (const match of importMatches) {
      const fileName = match[1];
      if (!expectedFileNames.has(fileName)) {
        logger.warn(`Extra tool not in spec: src/tools/${fileName}.ts`);
        extraCount++;
      }
    }

    if (missingCount === 0 && extraCount === 0) {
      logger.success(`Verified: all ${expectedTools.length} tools match the spec`);
    } else {
      await fail(`Verification failed: ${missingCount} missing, ${extraCount} extra tools`);
    }
  },
});

/**
 * Verify a dynamic-discovery project: the generator emits a single
 * `tool-catalog.json` (an array of tool entries) instead of per-tool files.
 * Validate that the catalog exists, parses, and lists every expected tool.
 */
async function verifyCatalog(
  catalogPath: string,
  expectedTools: ReturnType<typeof buildAllTools>,
): Promise<void> {
  let catalog: unknown;
  try {
    catalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
  } catch (err) {
    return await fail(`Failed to parse tool catalog: ${catalogPath}`, err);
  }

  if (!Array.isArray(catalog) || catalog.length === 0) {
    return await fail(`Tool catalog is empty or not a list: ${catalogPath}`);
  }

  const catalogNames = new Set(
    catalog
      .map((entry) => (entry as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string'),
  );

  let missingCount = 0;
  for (const tool of expectedTools) {
    if (!catalogNames.has(tool.name)) {
      logger.error(`Missing tool in catalog: ${tool.name}`);
      missingCount++;
    }
  }

  const expectedNames = new Set(expectedTools.map((t) => t.name));
  let extraCount = 0;
  for (const name of catalogNames) {
    if (!expectedNames.has(name)) {
      logger.warn(`Extra tool not in spec: ${name}`);
      extraCount++;
    }
  }

  if (missingCount === 0 && extraCount === 0) {
    logger.success(
      `Verified: all ${expectedTools.length} tools match the spec (dynamic discovery)`,
    );
  } else {
    await fail(`Verification failed: ${missingCount} missing, ${extraCount} extra tools`);
  }
}
