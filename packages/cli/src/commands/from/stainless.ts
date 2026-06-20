import { defineConfigurableCommand } from '@mcpmake/core';
import { readFile } from 'node:fs/promises';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { detectAuthSchemes } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { filterOperations } from '@mcpmake/core';
import { improveToolNames } from '@mcpmake/core';
import { buildResources, buildPrompts } from '@mcpmake/core';
import { emitProject, emitPythonProject } from '@mcpmake/core';
import { parseStainlessConfig, resolveSpecPath } from '@mcpmake/core';
import { translateStainless } from '@mcpmake/core';
import {
  targetArg,
  resolveTarget,
  resolveTransport,
  printWorkerNextSteps,
} from './target-support.js';
import { apiKeyArg, applyApiKey, modelArg, providerArg } from '../api-key.js';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';
import type { ProjectManifest } from '@mcpmake/core';

function toPackageName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface StainlessImportOptions {
  /** Path to the `stainless.yml` config file. */
  configPath: string;
  /** Output directory for the generated project. */
  output: string;
  /** Explicit OpenAPI spec path/URL (overrides the one referenced by the config). */
  spec?: string;
  name?: string;
  baseUrl?: string;
  transport?: string;
  target?: string;
  format?: string;
  include?: string;
  exclude?: string;
  improveNames?: boolean;
  model?: string;
  dynamicDiscovery?: boolean;
  staticTools?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface StainlessImportResult {
  serverName: string;
  toolCount: number;
  format: 'typescript' | 'python';
  target: 'node' | 'cloudflare';
  codeMode: boolean;
}

/**
 * Reproduce a Stainless MCP server as an owned mcpmake project.
 *
 * Reads the Stainless config + the OpenAPI spec it references, translates the
 * config's knobs into mcpmake's overlay model (mutating the in-memory spec with
 * `x-mcp-*` extensions), then runs the standard OpenAPI generation pipeline.
 * Exported separately from the citty command so it can be unit-tested directly.
 */
export async function importFromStainless(
  opts: StainlessImportOptions,
): Promise<StainlessImportResult> {
  let rawConfig: string;
  try {
    rawConfig = await readFile(opts.configPath, 'utf-8');
  } catch (err) {
    await fail(
      `Could not read Stainless config at ${opts.configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err; // unreachable (fail exits) — satisfies the type checker
  }

  const config = parseStainlessConfig(rawConfig);

  const specPath = resolveSpecPath(config, opts.configPath, opts.spec);
  if (!specPath) {
    await fail(
      'Stainless config does not reference an OpenAPI spec (no `openapi:`/`spec:` key). ' +
        'Pass the spec explicitly with --spec ./openapi.yaml.',
    );
  }

  logger.info(`Loading OpenAPI spec from: ${specPath}`);
  const { api } = await loadOpenApiSpec(specPath!);

  // Translate Stainless config → mcpmake overlay (mutates `api` in place).
  const translation = translateStainless(config, api as OpenAPIV3.Document);

  const {
    operations,
    baseUrl: specBaseUrl,
    securitySchemes,
    info,
  } = extractOperations(api as OpenAPIV3.Document);

  if (operations.length === 0) {
    await fail('No operations found in the referenced OpenAPI spec.');
  }
  logger.info(`Found ${operations.length} operations`);

  const filtered = filterOperations(operations, {
    include: opts.include?.split(',').map((s) => s.trim()),
    exclude: opts.exclude?.split(',').map((s) => s.trim()),
  });
  if (filtered.length === 0) {
    await fail('No operations left after filtering. Check your --include/--exclude patterns.');
  }
  if (filtered.length !== operations.length) {
    logger.info(`${filtered.length} operations after filtering`);
  }

  // LLM-assisted naming (opt-in; no-op without an LLM API key for the active provider)
  const named = opts.improveNames ? await improveToolNames(filtered, opts.model) : filtered;

  const tools = buildAllTools(named);

  const { authSchemes, envVars } = detectAuthSchemes(securitySchemes, {
    onlyScheme: translation.authOverride?.schemeName,
    envVarName: translation.authOverride?.envVarName,
  });

  // Warn (don't silently ignore) when an auth override can't be honoured.
  if (
    translation.authOverride?.schemeName &&
    !securitySchemes[translation.authOverride.schemeName]
  ) {
    logger.warn(
      `Stainless security_scheme "${translation.authOverride.schemeName}" is not declared in the ` +
        `spec's securitySchemes — emitting all detected schemes instead.`,
    );
  }
  if (
    translation.authOverride?.envVarName &&
    !authSchemes.some((s) => s.envVarName === translation.authOverride!.envVarName)
  ) {
    logger.warn(
      `Stainless read_env "${translation.authOverride.envVarName}" could not be applied ` +
        `(it only renames a single apiKey/bearer credential). Set the default env var instead, ` +
        `or rename it in the generated src/auth.ts / config.ts.`,
    );
  }

  const target = resolveTarget(opts.target);
  const transport = resolveTransport(target, opts.transport);

  const resources = buildResources(named);
  const prompts = buildPrompts(named);

  const serverName = opts.name ?? toPackageName(info.title || config.organization || 'mcp-server');

  // An explicit --base-url wins over the config's environments and the spec
  // (matches `from openapi`). When given, drop the environments seed so the
  // generated runtime resolver (MCP_ENVIRONMENTS → BASE_URL) honours it too.
  const explicitBaseUrl = !!opts.baseUrl;
  if (explicitBaseUrl && translation.environments) {
    logger.warn(
      '--base-url overrides the Stainless `environments` — not seeding MCP_ENVIRONMENTS/API_ENVIRONMENT.',
    );
  }
  const resolvedBaseUrl = opts.baseUrl ?? translation.baseUrl ?? specBaseUrl;
  if (!resolvedBaseUrl) {
    await fail(
      'No base URL found (spec, environments, or --base-url). Provide one with --base-url.',
    );
  }
  const environments = explicitBaseUrl ? undefined : translation.environments;
  const defaultEnvironment = explicitBaseUrl ? undefined : translation.defaultEnvironment;

  const outputFormat: 'typescript' | 'python' = opts.format === 'python' ? 'python' : 'typescript';
  if (target === 'cloudflare' && outputFormat === 'python') {
    await fail(
      '--target cloudflare is only available for TypeScript output (not --format python).',
    );
  }

  const manifest: ProjectManifest = {
    serverName,
    serverVersion: info.version ?? '1.0.0',
    baseUrl: resolvedBaseUrl!,
    transport,
    tools,
    resources,
    prompts,
    authSchemes,
    envVars: [
      { name: 'BASE_URL', description: 'API base URL', required: true, example: resolvedBaseUrl },
      ...envVars,
    ],
    dynamicDiscovery: opts.dynamicDiscovery ?? false,
    staticToolCount: opts.staticTools ? parseInt(opts.staticTools, 10) : undefined,
    target,
    environments,
    defaultEnvironment,
  };

  const emitOpts = {
    outputDir: opts.output,
    force: opts.force ?? false,
    dryRun: opts.dryRun ?? false,
  };

  logger.info(
    `Generating ${outputFormat} MCP server: ${serverName}` +
      (target === 'cloudflare' ? ' (Cloudflare Workers)' : ''),
  );

  if (outputFormat === 'python') {
    await emitPythonProject(manifest, emitOpts);
  } else {
    await emitProject(manifest, emitOpts);
  }

  printMigrationReport(translation, tools.length);

  if (!opts.dryRun) {
    logger.success(`MCP server generated at: ${opts.output}`);
    if (target === 'cloudflare') {
      printWorkerNextSteps(opts.output);
    } else if (outputFormat === 'python') {
      logger.info('');
      logger.info('Next steps:');
      logger.info(`  cd ${opts.output}`);
      logger.info('  cp .env.example .env  # fill in your credentials');
      logger.info('  pip install -r requirements.txt');
      logger.info('  python server.py');
    } else {
      logger.info('');
      logger.info('Next steps:');
      logger.info(`  cd ${opts.output}`);
      logger.info('  cp .env.example .env  # fill in your credentials');
      logger.info('  npm install && npm run build && npm start');
      logger.info('  # keep it in sync with the spec: mcpmake ci init');
    }
  }

  return {
    serverName,
    toolCount: tools.length,
    format: outputFormat,
    target,
    codeMode: translation.codeMode,
  };
}

function printMigrationReport(
  translation: ReturnType<typeof translateStainless>,
  toolCount: number,
): void {
  logger.info('');
  logger.info('Stainless → mcpmake migration report:');
  logger.info(`  • ${toolCount} owned, editable tool(s) generated.`);
  for (const line of translation.report) {
    logger.info(`  • ${line}`);
  }
  for (const warning of translation.warnings) {
    logger.warn(warning);
  }
}

export default defineConfigurableCommand('stainless', {
  meta: {
    name: 'stainless',
    description: 'Migrate a Stainless (stainless.yml) MCP server to an mcpmake server you own',
  },
  args: {
    // NB: keyed `config-file`, not `config` — `defineConfigurableCommand`
    // reserves `--config` for the .mcpmake.yaml path, which would shadow a
    // positional named `config`.
    'config-file': {
      type: 'positional',
      description: 'Path to the Stainless config file (stainless.yml)',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output directory for generated project',
      required: true,
    },
    spec: {
      type: 'string',
      description: 'OpenAPI spec path/URL (overrides the spec referenced by the config)',
    },
    name: {
      type: 'string',
      alias: 'n',
      description: 'Server name (defaults to API title from the spec)',
    },
    'base-url': {
      type: 'string',
      alias: 'b',
      description: 'Base URL override (defaults to the default environment or the spec)',
    },
    transport: {
      type: 'string',
      alias: 't',
      description: 'Transport mode: "stdio" (default) or "http"',
      default: 'stdio',
    },
    target: targetArg,
    format: {
      type: 'string',
      description: 'Output format: "typescript" (default) or "python"',
      default: 'typescript',
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
    'improve-names': {
      type: 'boolean',
      description:
        'Use AI to generate better tool names (requires an LLM API key: ANTHROPIC_API_KEY, or OPENAI_API_KEY with --provider openai)',
      default: false,
    },
    'api-key': apiKeyArg,
    provider: providerArg,
    model: modelArg,
    'dynamic-discovery': {
      type: 'boolean',
      description:
        'Emit meta-tools instead of N individual tools (recommended for code-mode / large APIs)',
      default: false,
    },
    'static-tools': {
      type: 'string',
      description: 'With --dynamic-discovery: also register the first N tools statically',
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
    applyApiKey(args);

    await importFromStainless({
      configPath: args['config-file'] as string,
      output: args.output as string,
      spec: args.spec as string | undefined,
      name: args.name as string | undefined,
      baseUrl: args['base-url'] as string | undefined,
      transport: args.transport as string | undefined,
      target: args.target as string | undefined,
      format: args.format as string | undefined,
      include: args.include as string | undefined,
      exclude: args.exclude as string | undefined,
      improveNames: args['improve-names'] as boolean | undefined,
      model: args.model as string | undefined,
      dynamicDiscovery: args['dynamic-discovery'] as boolean | undefined,
      staticTools: args['static-tools'] as string | undefined,
      force: args.force as boolean | undefined,
      dryRun: args['dry-run'] as boolean | undefined,
    });
  },
});
