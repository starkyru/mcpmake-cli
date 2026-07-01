import { defineConfigurableCommand } from '@mcpmake/core';
import { resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { loadOpenApiSpec } from '@mcpmake/core';
import { applyOverlay } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { detectAuthSchemes } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { filterOperations } from '@mcpmake/core';
import { confirmOperations } from '@mcpmake/core';
import { improveToolNames } from '@mcpmake/core';
import { resourceTreeNames } from '@mcpmake/core';
import { buildResources, buildPrompts } from '@mcpmake/core';
import { applyClientCompat, type ClientMode } from '@mcpmake/core';
import { emitProject, emitPythonProject } from '@mcpmake/core';
import { loadConfig, parseCompositeToolSpecs } from '@mcpmake/core';
import { printWorkerNextSteps } from './target-support.js';
import { apiKeyArg, applyApiKey, modelArg, providerArg } from '../api-key.js';
import { parseIntFlag, toPackageName } from '../../utils/cli-helpers.js';
import { generateMcpb } from '@mcpmake/core';
import { getProvider, getProviderNames } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { watchFile } from '@mcpmake/core';
import { childEnv } from '../../env.js';
import type { OpenAPIV3 } from 'openapi-types';

const execFile = promisify(execFileCb);

export default defineConfigurableCommand('openapi', {
  meta: {
    name: 'openapi',
    description: 'Generate an MCP server from an OpenAPI specification',
  },
  args: {
    spec: {
      type: 'positional',
      description: `Path/URL to OpenAPI spec, or provider name (${getProviderNames().join(', ')})`,
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
      description: 'Server name (defaults to API title from spec)',
    },
    'base-url': {
      type: 'string',
      alias: 'b',
      description: 'Base URL override (defaults to first server in spec)',
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
      description:
        'Only include operations matching these patterns (comma-separated tags, paths, or operationIds)',
    },
    exclude: {
      type: 'string',
      alias: 'e',
      description: 'Exclude operations matching these patterns (comma-separated)',
    },
    interactive: {
      type: 'boolean',
      description:
        'Curate: review the operations and select which to keep before generation (for large APIs)',
      default: false,
    },
    'mcp-ui': {
      type: 'boolean',
      description:
        'MCP Apps output: also emit a ui:// tool-launcher UI (mcp-ui standard) the server exposes',
      default: false,
    },
    a2a: {
      type: 'boolean',
      description:
        'A2A output: also emit an A2A server-wrapper (AgentCard + JSON-RPC) over the generated tools',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview generated files without writing',
      default: false,
    },
    client: {
      type: 'string',
      alias: 'c',
      description: 'Client compatibility mode: cursor, claude, openai',
    },
    'no-resources': {
      type: 'boolean',
      description: 'Skip generating MCP resources',
      default: false,
    },
    'no-prompts': {
      type: 'boolean',
      description: 'Skip generating MCP prompts',
      default: false,
    },
    'dynamic-discovery': {
      type: 'boolean',
      description: 'Emit 4 meta-tools instead of N individual tools (for large APIs)',
      default: false,
    },
    'static-tools': {
      type: 'string',
      description: 'With --dynamic-discovery: also register first N tools statically',
    },
    watch: {
      type: 'boolean',
      alias: 'w',
      description: 'Watch spec file for changes and regenerate',
      default: false,
    },
    'improve-names': {
      type: 'boolean',
      description:
        'Use AI to generate better tool names (requires an LLM API key: ANTHROPIC_API_KEY, or OPENAI_API_KEY with --provider openai)',
      default: false,
    },
    'api-key': apiKeyArg,
    provider: providerArg,
    model: modelArg,
    'resource-names': {
      type: 'boolean',
      description:
        'Name tools from the REST resource tree (POST /accounts → create_account); deterministic, offline, no API key',
      default: false,
    },
    overlay: {
      type: 'string',
      description:
        'Path to an OpenAPI Overlay file (YAML/JSON) to patch the spec before processing',
    },
    format: {
      type: 'string',
      description: 'Output format: "typescript" (default), "python"',
      default: 'typescript',
    },
    target: {
      type: 'string',
      description: 'Deployment target: "node" (default) or "cloudflare" (Cloudflare Workers)',
      default: 'node',
    },
    mcpb: {
      type: 'boolean',
      description: 'Also generate an .mcpb bundle for one-click Claude Desktop install',
      default: false,
    },
  },
  async run({ args }) {
    applyApiKey(args);

    // Resolve provider shortcut
    const provider = getProvider(args.spec);
    const specPath = provider?.specUrl ?? args.spec;
    if (provider) {
      logger.info(`Using provider template: ${provider.name} (${provider.description})`);
      if (provider.suggestedIncludes && !args.include) {
        logger.info(
          `Tip: use --include ${provider.suggestedIncludes.join(',')} to reduce tool count`,
        );
      }
    }

    logger.info(`Loading OpenAPI spec from: ${specPath}`);

    const { api } = await loadOpenApiSpec(specPath);

    // Apply overlay if specified (patches spec before extraction)
    if (args.overlay) {
      await applyOverlay(api as Record<string, unknown>, args.overlay);
    }

    let { operations, baseUrl, securitySchemes, info } = extractOperations(
      api as OpenAPIV3.Document,
    );

    if (operations.length === 0) {
      await fail('No operations found in the spec.');
    }

    logger.info(`Found ${operations.length} operations`);

    // Deterministic REST resource-tree naming (offline; no API key). Applied
    // before the optional LLM pass so AI can further refine if both are set.
    if (args['resource-names']) {
      operations = resourceTreeNames(operations);
    }

    // LLM-assisted naming
    if (args['improve-names']) {
      operations = await improveToolNames(operations, args.model);
    }

    const filtered = filterOperations(operations, {
      include: args.include?.split(',').map((s) => s.trim()),
      exclude: args.exclude?.split(',').map((s) => s.trim()),
    });

    if (filtered.length === 0) {
      await fail('No operations left after filtering. Check your --include/--exclude patterns.');
    }

    if (filtered.length !== operations.length) {
      logger.info(`${filtered.length} operations after filtering`);
    }

    // Curate: for a large API, interactively select which operations to keep (after any
    // --include/--exclude pre-filter). Same review flow as `from har`/`from url`.
    let selected = filtered;
    if (args.interactive) {
      selected = await confirmOperations(filtered);
      if (selected.length === 0) {
        await fail('No operations selected — nothing to generate.');
      }
    }

    let tools = buildAllTools(selected);
    if (args.client) {
      tools = applyClientCompat(tools, args.client as ClientMode);
    }
    const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

    const serverName = args.name ?? (provider ? provider.name : toPackageName(info.title));
    const resolvedBaseUrl = args['base-url'] ?? baseUrl ?? provider?.baseUrl;

    if (!resolvedBaseUrl) {
      await fail('No base URL found in spec. Use --base-url to provide one.');
    }

    const target: 'node' | 'cloudflare' = args.target === 'cloudflare' ? 'cloudflare' : 'node';

    // Cloudflare Workers always run as a stateless HTTP fetch handler — there is
    // no stdio there. Override transport so shared template data stays coherent.
    const transport =
      target === 'cloudflare' ? 'http' : args.transport === 'http' ? 'http' : 'stdio';

    const resources = args['no-resources'] ? [] : buildResources(selected);
    const prompts = args['no-prompts'] ? [] : buildPrompts(selected);

    const dynamicDiscovery = args['dynamic-discovery'] ?? false;
    const staticToolCount = args['static-tools']
      ? parseIntFlag(args['static-tools'], 'static-tools', 0)
      : undefined;

    // Composite tools are declared under `compositeTools:` in `.mcpmake.yaml`
    // (config presence is the trigger — no CLI flag). Parse + validate the shape
    // here so a malformed declaration fails fast with a clear build error; the
    // emitter then validates each step/returns/tool reference against the real
    // tool names. Absent config → empty list → output is byte-for-byte unchanged.
    let compositeTools;
    try {
      const loaded = loadConfig({
        configPath: typeof args.config === 'string' ? args.config : undefined,
      });
      compositeTools = parseCompositeToolSpecs(loaded?.data.compositeTools);
    } catch (err) {
      await fail(`compositeTools error: ${err instanceof Error ? err.message : String(err)}`, err);
    }

    // Composite tools invoke other tools by name through an in-process loopback
    // populated with the static tool surface. Under --dynamic-discovery with no
    // --static-tools, only discovery meta-tools are registered, so every
    // composite step would fail at runtime with "tool not found" (and the stdio
    // template would not even compile). Reject the combination up front.
    if (
      compositeTools &&
      compositeTools.length > 0 &&
      dynamicDiscovery &&
      (staticToolCount ?? 0) === 0
    ) {
      await fail(
        'Composite tools require static tools to call their steps, but --dynamic-discovery ' +
          'without --static-tools registers only discovery meta-tools. Add --static-tools=<N> ' +
          '(at least covering the tools your composites invoke) or drop --dynamic-discovery.',
      );
    }

    const manifest = {
      serverName,
      serverVersion: info.version ?? '1.0.0',
      baseUrl: resolvedBaseUrl,
      transport: transport as 'stdio' | 'http',
      tools,
      resources,
      prompts,
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
      dynamicDiscovery,
      staticToolCount,
      mcpUi: args['mcp-ui'] ?? false,
      a2a: args['a2a'] ?? false,
      compositeTools,
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
      logger.success(`Python MCP server generated at: ${args.output}`);
      logger.info('');
      logger.info('Next steps:');
      logger.info(`  cd ${args.output}`);
      logger.info('  cp .env.example .env  # fill in your credentials');
      logger.info('  pip install -r requirements.txt');
      logger.info('  python server.py');

      if (args.mcpb) {
        logger.warn('MCPB bundling is only supported for TypeScript projects');
      }
    } else {
      await emitProject(manifest, emitOpts);
      logger.success(`MCP server generated at: ${args.output}`);

      if (target === 'cloudflare') {
        if (args.mcpb) {
          logger.warn('MCPB bundling is not applicable to the Cloudflare Workers target');
        }
        printWorkerNextSteps(args.output);
      } else if (args.mcpb && !args['dry-run']) {
        const projectDir = resolve(args.output);

        logger.info('Installing production dependencies...');
        await execFile('npm', ['install', '--omit=dev'], {
          cwd: projectDir,
          timeout: 120_000,
          // Strip NODE_OPTIONS/loader vars so this spawn can't be hijacked into
          // running attacker code (defense in depth — see childEnv).
          env: childEnv(),
        });

        logger.info('Building project...');
        await execFile('npm', ['run', 'build'], {
          cwd: projectDir,
          timeout: 120_000,
          env: childEnv(),
        });

        logger.info('Creating .mcpb bundle...');
        const mcpbPath = await generateMcpb({ projectDir });
        logger.success(`MCPB bundle created: ${mcpbPath}`);
      } else {
        logger.info('');
        logger.info('Next steps:');
        logger.info(`  cd ${args.output}`);
        logger.info('  cp .env.example .env  # fill in your credentials');
        logger.info('  npm install');
        logger.info('  npm run build');
        logger.info('  npm start');
      }
    }

    // Watch mode — re-generate on spec file changes
    if (args.watch && !provider) {
      // Preserve the user's interactive curation across regenerations: keep only
      // the originally-selected operations that still exist (the prompt cannot be
      // replayed non-interactively).
      const selectedIds = args.interactive
        ? new Set(selected.map((op) => op.operationId))
        : undefined;
      watchFile({
        filePath: args.spec,
        onChange: async () => {
          const { api: freshApi } = await loadOpenApiSpec(specPath);
          if (args.overlay) {
            await applyOverlay(freshApi as Record<string, unknown>, args.overlay);
          }
          const fresh = extractOperations(freshApi as OpenAPIV3.Document);
          // Mirror the initial pipeline so a regeneration is identical to the
          // first emit — without this, --resource-names/--improve-names/--client
          // and the --no-resources/--no-prompts toggles were silently dropped and
          // the degraded output overwrote the correct one (force: true).
          let freshOps = fresh.operations;
          if (args['resource-names']) {
            freshOps = resourceTreeNames(freshOps);
          }
          if (args['improve-names']) {
            freshOps = await improveToolNames(freshOps, args.model);
          }
          let freshFiltered = filterOperations(freshOps, {
            include: args.include?.split(',').map((s) => s.trim()),
            exclude: args.exclude?.split(',').map((s) => s.trim()),
          });
          if (selectedIds) {
            freshFiltered = freshFiltered.filter((op) => selectedIds.has(op.operationId));
          }
          let freshTools = buildAllTools(freshFiltered);
          if (args.client) {
            freshTools = applyClientCompat(freshTools, args.client as ClientMode);
          }
          const freshAuth = detectAuthSchemes(fresh.securitySchemes);
          const freshResources = args['no-resources'] ? [] : buildResources(freshFiltered);
          const freshPrompts = args['no-prompts'] ? [] : buildPrompts(freshFiltered);
          await emitProject(
            {
              ...manifest,
              tools: freshTools,
              resources: freshResources,
              prompts: freshPrompts,
              authSchemes: freshAuth.authSchemes,
            },
            { outputDir: args.output, force: true, dryRun: false },
          );
        },
      });
      // Keep the process alive
      await new Promise(() => {});
    }
  },
});
