import { defineCommand } from 'citty';
import { loadHarFile } from '@mcpmake/core';
import { filterHarEntries } from '@mcpmake/core';
import { normalizeEntry } from '@mcpmake/core';
import { clusterEntries } from '@mcpmake/core';
import { clustersToOperations } from '@mcpmake/core';
import { deduplicateEntries } from '@mcpmake/core';
import { improveToolNames } from '@mcpmake/core';
import { resourceTreeNames } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { filterOperations } from '@mcpmake/core';
import { emitProject, emitPythonProject } from '@mcpmake/core';
import {
  targetArg,
  resolveTarget,
  resolveTransport,
  printWorkerNextSteps,
} from './target-support.js';
import { apiKeyArg, applyApiKey, modelArg } from '../api-key.js';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { confirmOperations } from '@mcpmake/core';
import type { AuthScheme, EnvVarDescriptor } from '@mcpmake/core';

function toPackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default defineCommand({
  meta: {
    name: 'har',
    description: 'Generate an MCP server from a HAR (HTTP Archive) file',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Path to HAR file (exported from browser DevTools)',
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
    domain: {
      type: 'string',
      alias: 'd',
      description: 'Only include requests to this domain (can repeat with commas)',
    },
    'include-errors': {
      type: 'boolean',
      description: 'Include requests that returned HTTP errors',
      default: false,
    },
    'improve-names': {
      type: 'boolean',
      description: 'Use AI to generate better tool names (requires ANTHROPIC_API_KEY)',
      default: false,
    },
    'api-key': apiKeyArg,
    model: modelArg,
    'resource-names': {
      type: 'boolean',
      description:
        'Name tools from the REST resource tree (POST /accounts → create_account); deterministic, offline, no API key',
      default: false,
    },
    dedup: {
      type: 'boolean',
      description: 'Deduplicate pagination and retry requests',
      default: true,
    },
    interactive: {
      type: 'boolean',
      description: 'Review and confirm detected tools before generation',
      default: false,
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Overwrite existing output directory',
      default: false,
    },
    transport: {
      type: 'string',
      alias: 't',
      description: 'Transport mode: "stdio" (default) or "http"',
      default: 'stdio',
    },
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
    'dry-run': {
      type: 'boolean',
      description: 'Preview generated files without writing',
      default: false,
    },
    format: {
      type: 'string',
      description: 'Output format: "typescript" (default), "python"',
      default: 'typescript',
    },
    target: targetArg,
  },
  async run({ args }) {
    applyApiKey(args);

    logger.info(`Loading HAR file: ${args.file}`);

    const har = await loadHarFile(args.file);
    logger.info(`Found ${har.log.entries.length} total entries`);

    // Filter noise
    const allowedDomains = args.domain?.split(',').map((d) => d.trim()) ?? [];
    const filtered = filterHarEntries(har.log.entries, {
      allowedDomains: allowedDomains.length > 0 ? allowedDomains : undefined,
      includeErrors: args['include-errors'] ?? false,
    });
    logger.info(`${filtered.length} API entries after filtering`);

    if (filtered.length === 0) {
      await fail('No API requests found after filtering. Try --domain to specify the API host.');
    }

    // Normalize paths (detect IDs, UUIDs, etc.)
    let normalized = filtered.map(normalizeEntry);

    // Deduplicate pagination and retries
    if (args.dedup !== false) {
      const before = normalized.length;
      normalized = deduplicateEntries(normalized);
      if (normalized.length < before) {
        logger.info(`Deduplicated: ${before} → ${normalized.length} entries`);
      }
    }

    // Cluster into logical operations
    const clusters = clusterEntries(normalized);
    logger.info(`Clustered into ${clusters.length} operations`);

    // Convert to OperationDescriptors (shared with OpenAPI pipeline)
    let { operations: allOperations, baseUrl, detectedAuth } = clustersToOperations(clusters);

    // Deterministic REST resource-tree naming (offline; no API key).
    if (args['resource-names']) {
      allOperations = resourceTreeNames(allOperations);
    }

    // LLM-assisted naming
    if (args['improve-names']) {
      allOperations = await improveToolNames(allOperations, args.model);
    }

    // Apply include/exclude filters
    let operations = filterOperations(allOperations, {
      include: args.include?.split(',').map((s) => s.trim()),
      exclude: args.exclude?.split(',').map((s) => s.trim()),
    });

    if (operations.length === 0) {
      await fail('No operations left after filtering.');
    }

    if (operations.length !== allOperations.length) {
      logger.info(`${operations.length} operations after filtering`);
    }

    // Interactive confirmation
    if (args.interactive) {
      operations = await confirmOperations(operations);
      if (operations.length === 0) {
        await fail('No operations selected.');
      }
    }

    // Convert detected auth to AuthSchemes
    const authSchemes: AuthScheme[] = [];
    const envVars: EnvVarDescriptor[] = [];

    for (const auth of detectedAuth) {
      if (auth.type === 'bearer') {
        authSchemes.push({
          type: 'http-bearer',
          envVarName: 'BEARER_TOKEN',
          description: 'Bearer token detected in HAR',
        });
        envVars.push({
          name: 'BEARER_TOKEN',
          description: 'Bearer authentication token',
          required: true,
        });
      } else if (auth.type === 'basic') {
        authSchemes.push({
          type: 'http-basic',
          envVarName: 'BASIC_USERNAME',
          description: 'Basic auth detected in HAR',
        });
        envVars.push(
          { name: 'BASIC_USERNAME', description: 'Basic auth username', required: true },
          { name: 'BASIC_PASSWORD', description: 'Basic auth password', required: true },
        );
      } else if (auth.type === 'apiKey') {
        authSchemes.push({
          type: 'apiKey',
          envVarName: 'API_KEY',
          headerName: auth.headerName,
          in: 'header',
          description: `API key header: ${auth.headerName}`,
        });
        envVars.push({
          name: 'API_KEY',
          description: `API key (sent as header "${auth.headerName}")`,
          required: true,
        });
      }
    }

    // Dedupe env vars
    const seen = new Set<string>();
    const uniqueEnvVars = envVars.filter((v) => {
      if (seen.has(v.name)) return false;
      seen.add(v.name);
      return true;
    });

    // Build tools (reuses OpenAPI pipeline)
    const tools = buildAllTools(operations);

    const serverName = args.name ?? toPackageName(new URL(baseUrl).hostname);

    const target = resolveTarget(args.target);
    const transport = resolveTransport(target, args.transport);

    const manifest = {
      serverName,
      serverVersion: '1.0.0',
      baseUrl,
      transport,
      tools,
      authSchemes,
      envVars: [
        { name: 'BASE_URL', description: 'API base URL', required: true, example: baseUrl },
        ...uniqueEnvVars,
      ],
      target,
    };

    const emitOpts = {
      outputDir: args.output,
      force: args.force ?? false,
      dryRun: args['dry-run'] ?? false,
    };

    const outputFormat = args.format ?? 'typescript';
    if (target === 'cloudflare' && outputFormat === 'python') {
      await fail(
        '--target cloudflare is only available for TypeScript output (not --format python)',
      );
    }
    logger.info(
      `Generating ${outputFormat} MCP server: ${serverName}` +
        (target === 'cloudflare' ? ' (Cloudflare Workers)' : ''),
    );

    if (outputFormat === 'python') {
      await emitPythonProject(manifest, emitOpts);
    } else {
      await emitProject(manifest, emitOpts);
    }

    logger.success(`MCP server generated at: ${args.output}`);
    logger.info('');
    logger.info(`Tools generated: ${tools.length}`);
    if (detectedAuth.length > 0) {
      logger.info(`Auth detected: ${detectedAuth.map((a) => a.type).join(', ')}`);
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
  },
});
