import { defineConfigurableCommand } from '@mcpmake/core';
import { loadPostmanCollection } from '@mcpmake/core';
import { normalizeEntry } from '@mcpmake/core';
import { clusterEntries } from '@mcpmake/core';
import { clustersToOperations } from '@mcpmake/core';
import { deduplicateEntries } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { filterOperations } from '@mcpmake/core';
import { buildResources, buildPrompts } from '@mcpmake/core';
import { emitProject } from '@mcpmake/core';
import {
  targetArg,
  resolveTarget,
  resolveTransport,
  printWorkerNextSteps,
} from './target-support.js';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import type { AuthScheme, EnvVarDescriptor } from '@mcpmake/core';

function toPackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default defineConfigurableCommand('postman', {
  meta: {
    name: 'postman',
    description: 'Generate an MCP server from a Postman Collection',
  },
  args: {
    collection: {
      type: 'positional',
      description: 'Path to Postman Collection JSON file (v2.1)',
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
      description: 'Server name (defaults to collection name)',
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
      description: 'Include operations matching patterns (comma-separated)',
    },
    exclude: {
      type: 'string',
      alias: 'e',
      description: 'Exclude operations matching patterns (comma-separated)',
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
    logger.info(`Loading Postman collection: ${args.collection}`);

    const { entries, collectionName } = await loadPostmanCollection(args.collection);
    logger.info(`Found ${entries.length} requests in collection`);

    if (entries.length === 0) {
      await fail('No requests found in collection.');
    }

    // Normalize → dedup → cluster → convert (shared pipeline)
    let normalized = entries.map(normalizeEntry);
    normalized = deduplicateEntries(normalized);

    const clusters = clusterEntries(normalized);
    logger.info(`Clustered into ${clusters.length} operations`);

    const { operations: allOperations, baseUrl, detectedAuth } = clustersToOperations(clusters);

    let operations = filterOperations(allOperations, {
      include: args.include?.split(',').map((s) => s.trim()),
      exclude: args.exclude?.split(',').map((s) => s.trim()),
    });

    if (operations.length === 0) {
      await fail('No operations left after filtering.');
    }

    const tools = buildAllTools(operations);
    const resources = buildResources(operations);
    const prompts = buildPrompts(operations);

    // Build auth
    const authSchemes: AuthScheme[] = [];
    const envVars: EnvVarDescriptor[] = [];
    for (const auth of detectedAuth) {
      if (auth.type === 'bearer') {
        authSchemes.push({ type: 'http-bearer', envVarName: 'BEARER_TOKEN' });
        envVars.push({ name: 'BEARER_TOKEN', description: 'Bearer token', required: true });
      } else if (auth.type === 'apiKey') {
        authSchemes.push({
          type: 'apiKey',
          envVarName: 'API_KEY',
          headerName: auth.headerName,
          in: 'header',
        });
        envVars.push({
          name: 'API_KEY',
          description: `API key (${auth.headerName})`,
          required: true,
        });
      }
    }

    const seen = new Set<string>();
    const uniqueEnvVars = envVars.filter((v) => {
      if (seen.has(v.name)) return false;
      seen.add(v.name);
      return true;
    });

    const serverName = args.name ?? toPackageName(collectionName);
    const target = resolveTarget(args.target);
    const transport = resolveTransport(target, args.transport);

    await emitProject(
      {
        serverName,
        serverVersion: '1.0.0',
        baseUrl: baseUrl || 'https://api.example.com',
        transport,
        tools,
        resources,
        prompts,
        authSchemes,
        envVars: [
          { name: 'BASE_URL', description: 'API base URL', required: true, example: baseUrl },
          ...uniqueEnvVars,
        ],
        target,
      },
      { outputDir: args.output, force: args.force ?? false, dryRun: args['dry-run'] ?? false },
    );

    logger.success(`MCP server generated at: ${args.output}`);
    logger.info(`Tools generated: ${tools.length}`);
    if (target === 'cloudflare') printWorkerNextSteps(args.output);
  },
});
