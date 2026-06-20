import { defineCommand } from 'citty';
import { recordBrowserSession } from '@mcpmake/core';
import { filterHarEntries } from '@mcpmake/core';
import { normalizeEntry } from '@mcpmake/core';
import { clusterEntries } from '@mcpmake/core';
import { clustersToOperations } from '@mcpmake/core';
import { deduplicateEntries } from '@mcpmake/core';
import { improveToolNames } from '@mcpmake/core';
import { resourceTreeNames } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { filterOperations } from '@mcpmake/core';
import { emitProject } from '@mcpmake/core';
import {
  targetArg,
  resolveTarget,
  resolveTransport,
  printWorkerNextSteps,
} from './target-support.js';
import { apiKeyArg, applyApiKey } from '../api-key.js';
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
    name: 'url',
    description: 'Generate an MCP server by recording browser interactions with a website',
  },
  args: {
    url: {
      type: 'positional',
      description: 'URL to open in the browser',
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
      description: 'Server name (defaults to hostname)',
    },
    timeout: {
      type: 'string',
      description: 'Idle timeout in seconds before auto-closing (default: 300)',
      default: '300',
    },
    headless: {
      type: 'boolean',
      description:
        'Headless / CI capture: load the page non-interactively (no window to drive) and capture API traffic automatically',
      default: false,
    },
    navigate: {
      type: 'string',
      description:
        'Comma-separated same-origin URLs/paths to auto-visit in --headless mode to surface more API calls',
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
    'improve-names': {
      type: 'boolean',
      description: 'Use AI to generate better tool names (requires ANTHROPIC_API_KEY)',
      default: false,
    },
    'api-key': apiKeyArg,
    'resource-names': {
      type: 'boolean',
      description:
        'Name tools from the REST resource tree (POST /accounts → create_account); deterministic, offline, no API key',
      default: false,
    },
    interactive: {
      type: 'boolean',
      description: 'Review and confirm detected tools before generation',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview generated files without writing',
      default: false,
    },
  },
  async run({ args }) {
    applyApiKey(args);

    const timeoutMs = parseInt(args.timeout ?? '300', 10) * 1000;

    // Record browser session
    const { entries, baseUrl } = await recordBrowserSession({
      url: args.url,
      timeout: timeoutMs,
      headless: args.headless ?? false,
      navigate: args.navigate
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });

    logger.info(`Captured ${entries.length} total requests`);

    // Filter noise (reuse HAR pipeline)
    const targetHost = new URL(args.url).hostname;
    const filtered = filterHarEntries(entries, {
      allowedDomains: [targetHost],
      includeErrors: false,
    });
    logger.info(`${filtered.length} API requests after filtering`);

    if (filtered.length === 0) {
      await fail(
        args.headless
          ? 'No API requests captured. Pass --navigate with paths that trigger API calls, or use interactive mode (omit --headless).'
          : 'No API requests captured. Try interacting with the page more.',
      );
    }

    // Normalize → dedup → cluster → convert (shared HAR pipeline)
    let normalized = filtered.map(normalizeEntry);
    const beforeDedup = normalized.length;
    normalized = deduplicateEntries(normalized);
    if (normalized.length < beforeDedup) {
      logger.info(`Deduplicated: ${beforeDedup} → ${normalized.length} entries`);
    }

    const clusters = clusterEntries(normalized);
    logger.info(`Clustered into ${clusters.length} operations`);

    let { operations: allOperations, detectedAuth } = clustersToOperations(clusters);

    // Deterministic REST resource-tree naming (offline; no API key).
    if (args['resource-names']) {
      allOperations = resourceTreeNames(allOperations);
    }

    // LLM-assisted naming
    if (args['improve-names']) {
      allOperations = await improveToolNames(allOperations);
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

    // Build auth schemes
    const authSchemes: AuthScheme[] = [];
    const envVars: EnvVarDescriptor[] = [];

    for (const auth of detectedAuth) {
      if (auth.type === 'bearer') {
        authSchemes.push({
          type: 'http-bearer',
          envVarName: 'BEARER_TOKEN',
          description: 'Bearer token detected from browser session',
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
          description: 'Basic auth detected from browser session',
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
