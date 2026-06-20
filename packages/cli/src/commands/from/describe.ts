import { defineConfigurableCommand } from '@mcpmake/core';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSpecFromDescription } from '@mcpmake/core';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { detectAuthSchemes } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { filterOperations } from '@mcpmake/core';
import { emitProject } from '@mcpmake/core';
import {
  targetArg,
  resolveTarget,
  resolveTransport,
  printWorkerNextSteps,
} from './target-support.js';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';

function toPackageName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default defineConfigurableCommand('describe', {
  meta: {
    name: 'describe',
    description: 'Generate an MCP server from a natural language description using AI',
  },
  args: {
    description: {
      type: 'positional',
      description: 'Natural language description of the API (e.g., "manage GitHub issues")',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output directory for generated project',
      required: true,
    },
    name: {
      type: 'string',
      alias: 'n',
      description: 'Server name',
    },
    'base-url': {
      type: 'string',
      alias: 'b',
      description: 'Base URL for the API',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Claude model to use (default: claude-sonnet-4-6)',
    },
    'save-spec': {
      type: 'string',
      description: 'Save the generated OpenAPI spec to this path',
    },
    transport: {
      type: 'string',
      alias: 't',
      description: 'Transport mode: "stdio" (default) or "http"',
      default: 'stdio',
    },
    target: targetArg,
    include: {
      type: 'string',
      alias: 'i',
      description: 'Only include operations matching these patterns (comma-separated)',
    },
    exclude: {
      type: 'string',
      alias: 'e',
      description: 'Exclude operations matching these patterns (comma-separated)',
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Overwrite existing output directory',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview generated files without writing',
      default: false,
    },
  },
  async run({ args }) {
    // Generate OpenAPI spec from description
    const specJson = await generateSpecFromDescription({
      description: args.description,
      baseUrl: args['base-url'],
      model: args.model,
    });

    // Save spec if requested
    if (args['save-spec']) {
      await writeFile(args['save-spec'], specJson, 'utf-8');
      logger.info(`Saved generated spec to: ${args['save-spec']}`);
    }

    // Write spec to temp file and parse through the OpenAPI pipeline
    const tempDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-describe-'));
    const tempSpecPath = resolve(tempDir, 'generated-spec.json');

    try {
      await writeFile(tempSpecPath, specJson, 'utf-8');

      const { api } = await loadOpenApiSpec(tempSpecPath);
      const { operations, baseUrl, securitySchemes, info } = extractOperations(
        api as OpenAPIV3.Document,
      );

      if (operations.length === 0) {
        await fail('Generated spec has no operations. Try a more specific description.');
      }

      logger.info(`Generated ${operations.length} operations`);

      const filtered = filterOperations(operations, {
        include: args.include?.split(',').map((s) => s.trim()),
        exclude: args.exclude?.split(',').map((s) => s.trim()),
      });

      if (filtered.length === 0) {
        await fail('No operations left after filtering.');
      }

      if (filtered.length !== operations.length) {
        logger.info(`${filtered.length} operations after filtering`);
      }

      const tools = buildAllTools(filtered);
      const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

      const serverName = args.name ?? toPackageName(info.title);
      const resolvedBaseUrl = args['base-url'] ?? baseUrl;
      const target = resolveTarget(args.target);
      const transport = resolveTransport(target, args.transport);

      const manifest = {
        serverName,
        serverVersion: info.version ?? '1.0.0',
        baseUrl: resolvedBaseUrl || 'https://api.example.com',
        transport,
        tools,
        authSchemes,
        envVars: [
          {
            name: 'BASE_URL',
            description: 'API base URL',
            required: true,
            example: resolvedBaseUrl,
          },
          ...envVars,
        ],
        target,
      };

      logger.info(
        `Generating MCP server: ${serverName}` +
          (target === 'cloudflare' ? ' (Cloudflare Workers)' : ''),
      );
      await emitProject(manifest, {
        outputDir: args.output,
        force: args.force ?? false,
        dryRun: args['dry-run'] ?? false,
      });

      logger.success(`MCP server generated at: ${args.output}`);
      logger.info('');
      logger.info(`Tools generated: ${tools.length}`);
      for (const tool of tools) {
        logger.info(`  - ${tool.name}: ${tool.description}`);
      }
      if (target === 'cloudflare') {
        printWorkerNextSteps(args.output);
      } else {
        logger.info('');
        logger.info('Next steps:');
        logger.info(`  cd ${args.output}`);
        logger.info('  cp .env.example .env  # fill in your credentials');
        logger.info('  npm install');
        logger.info('  npm run build');
        logger.info('  npm start');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
});
