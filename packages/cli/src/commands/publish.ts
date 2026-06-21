import { defineCommand } from 'citty';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { stringify as yamlStringify } from 'yaml';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { pathExists } from '@mcpmake/core';
import {
  buildServerJson,
  deriveServerName,
  parseEnvExample,
  validateServerName,
  OFFICIAL_REGISTRY_URL,
  type RegistryEnvVar,
} from '../registry/official-registry.js';

const execFile = promisify(execFileCb);

/**
 * JSON.parse reviver that drops prototype-polluting keys. Project files
 * (`package.json`, `tool-catalog.json`) are read from a directory the operator
 * points at, so they are untrusted input — strip `__proto__`/`constructor`/
 * `prototype` rather than let a crafted file seed a polluted object.
 */
const stripProtoKeys = (key: string, value: unknown): unknown =>
  key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value;

interface ToolInfo {
  name: string;
  description: string;
}

interface RegistryManifest {
  name: string;
  version: string;
  description: string;
  transport: string;
  tools: ToolInfo[];
}

export default defineCommand({
  meta: {
    name: 'publish',
    description:
      'Generate registry manifests (Smithery/Glama) or publish to the official MCP Registry',
  },
  args: {
    directory: {
      type: 'positional',
      description: 'Path to the generated MCP server project',
      required: true,
    },
    registry: {
      type: 'string',
      alias: 'r',
      description: 'Target registry: official, smithery, glama (default: smithery + glama)',
    },
    name: {
      type: 'string',
      alias: 'n',
      description:
        'official: registry name (e.g. io.github.you/my-server); default derived from the git remote',
    },
    'remote-url': {
      type: 'string',
      description: 'official: hosted endpoint URL to advertise as a remote (streamable-http)',
    },
    push: {
      type: 'boolean',
      description:
        'official: run `mcp-publisher publish` after generating server.json (requires login + npm publish first)',
      default: false,
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description:
        'Skip the interactive confirmation before --push (required in non-interactive runs)',
      default: false,
    },
  },
  async run({ args }) {
    const projectDir = resolve(args.directory);

    const pkgPath = resolve(projectDir, 'package.json');
    if (!(await pathExists(pkgPath))) {
      await fail(`Not a valid project directory (no package.json): ${projectDir}`);
    }

    const registry = args.registry?.toLowerCase();
    if (registry && !['official', 'smithery', 'glama'].includes(registry)) {
      await fail('Invalid registry. Use "official", "smithery", "glama", or omit for both.');
    }

    // Read project metadata
    const pkgJson = JSON.parse(await readFile(pkgPath, 'utf-8'), stripProtoKeys);

    // The official MCP Registry has a distinct flow (server.json + mcp-publisher).
    if (registry === 'official') {
      await publishOfficial(projectDir, pkgPath, pkgJson, {
        name: args.name,
        remoteUrl: args['remote-url'],
        push: args.push ?? false,
        yes: args.yes ?? false,
      });
      return;
    }

    const name: string = pkgJson.name ?? 'mcp-server';
    const version: string = pkgJson.version ?? '1.0.0';
    const description: string = pkgJson.description ?? '';

    // Detect transport mode from the project's main entry
    const transport = await detectTransport(projectDir);

    // Extract tool list
    const tools = await extractTools(projectDir);

    if (tools.length === 0) {
      logger.warn('No tools found in the project. The manifest will have an empty tool list.');
    } else {
      logger.info(`Found ${tools.length} tool(s)`);
    }

    const manifest: RegistryManifest = { name, version, description, transport, tools };

    const generateSmithery = !registry || registry === 'smithery';
    const generateGlama = !registry || registry === 'glama';

    if (generateSmithery) {
      await writeSmitheryManifest(projectDir, manifest);
    }
    if (generateGlama) {
      await writeGlamaManifest(projectDir, manifest);
    }

    // Print next steps
    logger.info('');
    logger.success('Next steps:');
    logger.info('  1. Review the generated manifest file(s)');
    logger.info('  2. Commit and push to your GitHub repository');
    if (generateSmithery) {
      logger.info('  3. Register your server at https://smithery.ai — Smithery discovers');
      logger.info('     servers from GitHub repos containing a smithery.yaml file');
    }
    if (generateGlama) {
      logger.info(
        `  ${generateSmithery ? '4' : '3'}. Submit your server at https://glama.ai/mcp/servers — Glama discovers`,
      );
      logger.info('     servers from GitHub repos containing a glama.json file');
    }
  },
});

/**
 * Detect whether the project uses stdio or HTTP transport by inspecting the
 * main server entry file.
 *
 * For both targets the emitter writes a single entry point: `src/index.ts`.
 * HTTP projects render `server-main-http.ts` into that file, which contains
 * `StreamableHTTPServerTransport` (or `SSEServerTransport`); stdio projects
 * render `server-main.ts`, which contains neither.
 *
 * Inspected file: src/index.ts
 *
 * Exported for unit testing.
 */
export async function detectTransport(projectDir: string): Promise<string> {
  const entry = resolve(projectDir, 'src/index.ts');
  if (await pathExists(entry)) {
    try {
      const content = await readFile(entry, 'utf-8');
      if (
        content.includes('SSEServerTransport') ||
        content.includes('StreamableHTTPServerTransport')
      ) {
        return 'http';
      }
    } catch {
      // ignore read errors
    }
  }

  return 'stdio';
}

/**
 * Extract tool names and descriptions from the generated project.
 * Tries multiple sources in priority order:
 *   1. tool-catalog.json (dynamic discovery mode)
 *   2. Individual tool handler files in src/tools/
 */
async function extractTools(projectDir: string): Promise<ToolInfo[]> {
  // Strategy 1: tool-catalog.json (dynamic discovery projects)
  const catalogPath = resolve(projectDir, 'src/tool-catalog.json');
  if (await pathExists(catalogPath)) {
    try {
      const catalog = JSON.parse(await readFile(catalogPath, 'utf-8'), stripProtoKeys);
      if (Array.isArray(catalog)) {
        return catalog.map((entry: { name: string; description?: string; title?: string }) => ({
          name: entry.name,
          description: entry.description ?? entry.title ?? '',
        }));
      }
    } catch {
      logger.warn('Failed to parse tool-catalog.json, falling back to tool file scanning');
    }
  }

  // Strategy 2: Parse individual tool handler files in src/tools/
  const toolsDir = resolve(projectDir, 'src/tools');
  if (!(await pathExists(toolsDir))) {
    return [];
  }

  const tools: ToolInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(toolsDir);
  } catch {
    return [];
  }

  for (const file of entries) {
    if (file === 'index.ts' || !file.endsWith('.ts')) continue;

    try {
      const content = await readFile(join(toolsDir, file), 'utf-8');

      // Extract the tool name from server.registerTool('name', ...)
      const nameMatch = content.match(/registerTool\(\s*['"]([^'"]+)['"]/);
      if (!nameMatch) continue;

      const toolName = nameMatch[1];

      // Extract the description from description: `...` or description: '...'
      const descMatch = content.match(/description:\s*[`'"]([^`'"]*)[`'"]/);
      const toolDescription = descMatch ? descMatch[1] : '';

      tools.push({ name: toolName, description: toolDescription });
    } catch {
      // skip files that can't be read
    }
  }

  return tools;
}

async function writeSmitheryManifest(
  projectDir: string,
  manifest: RegistryManifest,
): Promise<void> {
  const smitheryData = {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    transport: manifest.transport,
    tools: manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  };

  const yamlContent = yamlStringify(smitheryData, { lineWidth: 120 });
  const outputPath = resolve(projectDir, 'smithery.yaml');
  await writeFile(outputPath, yamlContent, 'utf-8');
  logger.success(`Generated ${outputPath}`);
}

async function writeGlamaManifest(projectDir: string, manifest: RegistryManifest): Promise<void> {
  const glamaData = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    transport: manifest.transport,
    tools: manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  };

  const jsonContent = JSON.stringify(glamaData, null, 2) + '\n';
  const outputPath = resolve(projectDir, 'glama.json');
  await writeFile(outputPath, jsonContent, 'utf-8');
  logger.success(`Generated ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Official MCP Registry (registry.modelcontextprotocol.io)
// ---------------------------------------------------------------------------

interface OfficialOpts {
  name?: string;
  remoteUrl?: string;
  push: boolean;
  yes: boolean;
}

/**
 * Generate a schema-conformant `server.json`, set the npm `mcpName` validation
 * marker, and either print the publish steps or (with --push) run the official
 * `mcp-publisher` CLI. mcpmake never re-implements the registry auth flow.
 */
async function publishOfficial(
  projectDir: string,
  pkgPath: string,
  pkgJson: Record<string, unknown>,
  opts: OfficialOpts,
): Promise<void> {
  const packageName = typeof pkgJson.name === 'string' ? pkgJson.name : undefined;
  if (!packageName) {
    return await fail(
      'package.json has no "name" — set it before publishing to the official registry.',
    );
  }
  const version = typeof pkgJson.version === 'string' ? pkgJson.version : '1.0.0';
  const description = typeof pkgJson.description === 'string' ? pkgJson.description : undefined;

  // Repository URL: package.json `repository`, else the git `origin` remote.
  const repositoryUrl = extractRepoUrl(pkgJson.repository) ?? (await gitRemoteUrl(projectDir));

  const name = deriveServerName({ explicit: opts.name, repositoryUrl });
  if (!name) {
    logger.info(
      'Pass --name (e.g. --name io.github.you/my-server) or add a GitHub "repository" to package.json.',
    );
    return await fail('Could not determine the registry name.');
  }
  const nameError = validateServerName(name);
  if (nameError) {
    return await fail(nameError);
  }

  // Environment variables from .env.example feed the server.json env spec.
  let envVars: RegistryEnvVar[] = [];
  const envPath = resolve(projectDir, '.env.example');
  if (await pathExists(envPath)) {
    envVars = parseEnvExample(await readFile(envPath, 'utf-8'));
  }

  const serverJson = buildServerJson({
    name,
    description,
    version,
    repositoryUrl,
    packageIdentifier: packageName,
    packageVersion: version,
    environmentVariables: envVars,
    remoteUrl: opts.remoteUrl,
  });

  const serverJsonPath = resolve(projectDir, 'server.json');
  await writeFile(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n', 'utf-8');
  logger.success(`Generated ${serverJsonPath}`);

  // The registry validates that the npm package's `mcpName` matches the server
  // name. Add/update it idempotently so `mcp-publisher publish` validates.
  if (pkgJson.mcpName !== name) {
    const updated = { ...pkgJson, mcpName: name };
    await writeFile(pkgPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    logger.info(`Set "mcpName": "${name}" in package.json (required for npm validation)`);
  }

  if (opts.push) {
    const confirmed = await confirmPush(name, opts.yes);
    if (!confirmed) {
      return await fail('Aborted: publishing to the public registry was not confirmed.');
    }
    await runMcpPublisher(projectDir);
    return;
  }

  logger.info('');
  logger.success(`Ready to publish ${name} to the official MCP Registry.`);
  logger.info('Next steps:');
  logger.info('  1. Publish the package to npm (the registry hosts metadata, not artifacts):');
  logger.info('       npm publish --access public');
  logger.info('  2. Install mcp-publisher: https://modelcontextprotocol.io/registry/quickstart');
  logger.info('  3. Authenticate (the namespace must match your GitHub login):');
  logger.info('       mcp-publisher login github');
  logger.info('  4. Publish the server metadata:');
  logger.info(`       cd ${projectDir} && mcp-publisher publish`);
  logger.info('');
  logger.info(`Re-run with --push to run step 4 automatically. Registry: ${OFFICIAL_REGISTRY_URL}`);
}

/** Normalize a package.json `repository` field to a plain https URL. */
function extractRepoUrl(repository: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof repository === 'string') {
    raw = repository;
  } else if (repository && typeof repository === 'object' && 'url' in repository) {
    const u = (repository as { url?: unknown }).url;
    if (typeof u === 'string') raw = u;
  }
  if (!raw) return undefined;
  raw = raw.replace(/^git\+/, '');
  const shorthand = raw.match(/^github:([^/]+\/[^/]+)$/);
  if (shorthand) raw = `https://github.com/${shorthand[1]}`;
  return raw.replace(/\.git$/, '');
}

/** Best-effort `git remote get-url origin` for the project directory. */
async function gitRemoteUrl(projectDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', ['-C', projectDir, 'remote', 'get-url', 'origin']);
    const url = stdout.trim();
    return url ? url.replace(/^git\+/, '').replace(/\.git$/, '') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Confirm the irreversible public-registry write before pushing.
 *
 * Returns true only when the user explicitly consents. `--yes` skips the
 * prompt. In a non-interactive run (no TTY or CI) we never silently proceed:
 * the caller must pass `--yes`, otherwise this returns false.
 */
export async function confirmPush(name: string, yes: boolean): Promise<boolean> {
  if (yes) return true;

  const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!interactive || process.env.CI) {
    logger.error(
      `Refusing to push ${name} to the public ${OFFICIAL_REGISTRY_URL} registry without confirmation.`,
    );
    logger.info('Re-run with --yes to publish in a non-interactive environment.');
    return false;
  }

  logger.warn('');
  logger.warn(
    `This will PUBLICLY publish "${name}" to the official MCP Registry (${OFFICIAL_REGISTRY_URL}).`,
  );
  logger.warn('This is irreversible — the listing becomes visible to everyone.');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer: string = await new Promise((res) =>
      rl.question('Type "yes" to publish, anything else to abort: ', res),
    );
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/** Run the official `mcp-publisher publish` CLI in the project directory. */
async function runMcpPublisher(projectDir: string): Promise<void> {
  logger.info(`Publishing to ${OFFICIAL_REGISTRY_URL} via mcp-publisher...`);
  try {
    const { stdout, stderr } = await execFile('mcp-publisher', ['publish'], { cwd: projectDir });
    if (stdout.trim()) logger.info(stdout.trim());
    if (stderr.trim()) logger.info(stderr.trim());
    logger.success('Published to the official MCP Registry.');
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === 'ENOENT') {
      logger.info('Install it: https://modelcontextprotocol.io/registry/quickstart');
      await fail('mcp-publisher is not installed or not on PATH.', err);
    } else {
      if (e.stdout?.trim()) logger.info(e.stdout.trim());
      if (e.stderr?.trim()) logger.error(e.stderr.trim());
      await fail(
        'mcp-publisher publish failed. Ensure you ran `mcp-publisher login github` and published to npm first.',
        err,
      );
    }
  }
}
