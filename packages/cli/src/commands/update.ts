import { defineCommand } from 'citty';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { detectAuthSchemes } from '@mcpmake/core';
import { buildResources, buildPrompts } from '@mcpmake/core';
import { emitProject } from '@mcpmake/core';
import { pathExists } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';

/**
 * JSON.parse reviver that drops prototype-polluting keys from the untrusted
 * project `package.json` (read from an operator-supplied directory).
 */
const stripProtoKeys = (key: string, value: unknown): unknown =>
  key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value;

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Update a generated project from a changed spec (incremental re-generation)',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Path to the updated OpenAPI spec',
      required: true,
    },
    project: {
      type: 'string',
      alias: 'p',
      description: 'Path to the existing generated project',
      required: true,
    },
  },
  async run({ args }) {
    logger.info(`Updating project from spec: ${args.spec}`);

    const projectDir = args.project;
    const toolsDir = resolve(projectDir, 'src/tools');

    if (!(await pathExists(resolve(projectDir, 'package.json')))) {
      await fail(`Not a valid project directory: ${projectDir}`);
    }

    // Load current tool index to see what exists
    const toolIndexPath = resolve(projectDir, 'src/tools/index.ts');
    const existingToolIndex = (await pathExists(toolIndexPath))
      ? await readFile(toolIndexPath, 'utf-8')
      : '';

    const existingFileNames = new Set<string>();
    const importMatches = existingToolIndex.matchAll(/from '\.\/([^']+)\.js'/g);
    for (const match of importMatches) {
      existingFileNames.add(match[1]);
    }

    // Parse the new spec
    const { api } = await loadOpenApiSpec(args.spec);
    const { operations, baseUrl, securitySchemes, info } = extractOperations(
      api as OpenAPIV3.Document,
    );

    const tools = buildAllTools(operations);
    const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);
    const resources = buildResources(operations);
    const prompts = buildPrompts(operations);

    const newFileNames = new Set(tools.map((t) => t.fileName));

    // Diff
    const added = tools.filter((t) => !existingFileNames.has(t.fileName));
    const removed = [...existingFileNames].filter((f) => !newFileNames.has(f));
    const unchanged = tools.filter((t) => existingFileNames.has(t.fileName));

    logger.info(
      `Diff: +${added.length} added, -${removed.length} removed, ${unchanged.length} updated`,
    );

    if (added.length === 0 && removed.length === 0) {
      logger.info('No structural changes. Regenerating all tool files to sync schemas.');
    }

    // Determine server name from existing package.json
    const pkgJson = JSON.parse(
      await readFile(resolve(projectDir, 'package.json'), 'utf-8'),
      stripProtoKeys,
    );
    const serverName = pkgJson.name;

    if (typeof serverName !== 'string' || serverName.trim() === '') {
      await fail(`package.json in ${projectDir} is missing a valid "name" field`);
      return;
    }

    // Regenerate the full project (force overwrite)
    await emitProject(
      {
        serverName,
        serverVersion: info.version ?? pkgJson.version ?? '1.0.0',
        baseUrl: baseUrl || 'https://api.example.com',
        transport: 'stdio',
        tools,
        resources,
        prompts,
        authSchemes,
        envVars: [{ name: 'BASE_URL', description: 'API base URL', required: true }, ...envVars],
      },
      { outputDir: projectDir, force: true, dryRun: false },
    );

    logger.success('Project updated successfully');
    if (added.length > 0) {
      logger.info(`New tools: ${added.map((t) => t.name).join(', ')}`);
    }
    if (removed.length > 0) {
      logger.warn(`Removed tools (files may still exist): ${removed.join(', ')}`);
    }
  },
});
