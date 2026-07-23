import { defineCommand } from 'citty';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { detectAuthSchemes } from '@mcpmake/core';
import { verifyLive } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { pathExists } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';

export default defineCommand({
  meta: {
    name: 'verify',
    description:
      'Verify a generated MCP server against its spec (static), or the spec against the live API (--live)',
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
      description: 'Generated project directory (static spec-vs-server check)',
    },
    live: {
      type: 'boolean',
      description: 'Replay the spec against the live API and flag response-shape drift',
      default: false,
    },
    'base-url': {
      type: 'string',
      alias: 'b',
      description: "Base URL for --live (defaults to the spec's servers[0].url)",
    },
    'include-writes': {
      type: 'boolean',
      description:
        '--live: also replay write operations (POST/PUT/PATCH/DELETE). Off by default — never mutates the API without this.',
      default: false,
    },
    timeout: {
      type: 'string',
      description: '--live: per-request timeout in ms (default 15000)',
    },
    format: {
      type: 'string',
      description: '--live: output format (text | json)',
      default: 'text',
    },
  },
  async run({ args }) {
    const { api } = await loadOpenApiSpec(args.spec);
    const { operations, baseUrl, securitySchemes } = extractOperations(api as OpenAPIV3.Document);

    const wantStatic = typeof args.project === 'string' && args.project.length > 0;
    const wantLive = args.live === true;

    if (!wantStatic && !wantLive) {
      return await fail(
        'Nothing to verify: pass -p <project> for a static check, or --live to check against the live API.',
      );
    }

    let anyFailure = false;

    if (wantStatic) {
      const ok = await verifyStatic(args.project as string, operations);
      if (!ok) anyFailure = true;
    }

    if (wantLive) {
      const ok = await runLive(args, operations, baseUrl, securitySchemes);
      if (!ok) anyFailure = true;
    }

    if (anyFailure) {
      return await fail('Verification failed');
    }
  },
});

/**
 * Static check: every tool the spec implies has a generated, registered file
 * (or catalog entry for dynamic-discovery projects). Returns true on match;
 * logs each divergence and returns false otherwise. Does not exit the process —
 * the caller aggregates and calls fail() once.
 */
async function verifyStatic(
  project: string,
  operations: ReturnType<typeof extractOperations>['operations'],
): Promise<boolean> {
  logger.info('Verifying generated project against the spec (static)');
  const expectedTools = buildAllTools(operations);

  // Dynamic-discovery projects emit a single tool-catalog.json instead of
  // per-tool files, so verify against the catalog rather than tool files.
  const catalogPath = resolve(project, 'src/tool-catalog.json');
  if (await pathExists(catalogPath)) {
    return await verifyCatalog(catalogPath, expectedTools);
  }

  const toolIndexPath = resolve(project, 'src/tools/index.ts');
  if (!(await pathExists(toolIndexPath))) {
    logger.error(`Tool index not found at: ${toolIndexPath}`);
    return false;
  }

  const toolIndex = await readFile(toolIndexPath, 'utf-8');

  let missingCount = 0;
  let extraCount = 0;

  for (const tool of expectedTools) {
    const toolFile = resolve(project, `src/tools/${tool.fileName}.ts`);
    if (!(await pathExists(toolFile))) {
      logger.error(`Missing tool file: src/tools/${tool.fileName}.ts (${tool.name})`);
      missingCount++;
    } else if (!toolIndex.includes(`'./${tool.fileName}.js'`)) {
      // Match the exact import literal the index emits (`from './<fileName>.js'`)
      // — a bare substring check false-passes when one fileName is a prefix of
      // another (e.g. `get` masked by `get-users.js`), hiding a real drift.
      logger.warn(`Tool file exists but not registered: ${tool.fileName}`);
      missingCount++;
    }
  }

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
    return true;
  }
  logger.error(`Static verification failed: ${missingCount} missing, ${extraCount} extra tools`);
  return false;
}

/**
 * Verify a dynamic-discovery project against its `tool-catalog.json`. Returns
 * true when the catalog exists, parses, and lists exactly the spec's tools.
 */
async function verifyCatalog(
  catalogPath: string,
  expectedTools: ReturnType<typeof buildAllTools>,
): Promise<boolean> {
  let catalog: unknown;
  try {
    catalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
  } catch (err) {
    logger.error(
      `Failed to parse tool catalog: ${catalogPath} (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }

  if (!Array.isArray(catalog) || catalog.length === 0) {
    logger.error(`Tool catalog is empty or not a list: ${catalogPath}`);
    return false;
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
    return true;
  }
  logger.error(`Static verification failed: ${missingCount} missing, ${extraCount} extra tools`);
  return false;
}

/**
 * Live check: replay each operation against the real API and compare responses
 * to their declared schema. Returns true when nothing drifted/errored.
 */
async function runLive(
  args: Record<string, unknown>,
  operations: ReturnType<typeof extractOperations>['operations'],
  specBaseUrl: string | undefined,
  securitySchemes: Parameters<typeof detectAuthSchemes>[0] | undefined,
): Promise<boolean> {
  const resolvedBase = (args['base-url'] as string | undefined) ?? specBaseUrl;
  if (!resolvedBase) {
    logger.error('No base URL for --live. Provide --base-url or a spec with servers[].');
    return false;
  }

  // In JSON mode stdout must be pure JSON (consola's info/success go to stdout),
  // so all human-facing log lines are suppressed and only the report is printed.
  const jsonMode = args.format === 'json';
  const { authSchemes } = detectAuthSchemes(securitySchemes ?? {});
  const includeWrites = args['include-writes'] === true;
  if (includeWrites && !jsonMode) {
    logger.warn('--include-writes: replaying WRITE operations against the live API.');
  }

  let timeoutMs: number | undefined;
  const rawTimeout = args.timeout as string | undefined;
  if (rawTimeout !== undefined) {
    const n = Number(rawTimeout);
    if (!Number.isFinite(n) || n <= 0) {
      logger.error(`Invalid --timeout: ${rawTimeout}`);
      return false;
    }
    timeoutMs = n;
  }

  if (!jsonMode) logger.info(`Live-verifying spec against ${resolvedBase}`);
  const report = await verifyLive(operations, {
    baseUrl: resolvedBase,
    env: process.env,
    authSchemes,
    includeWrites,
    timeoutMs,
  });

  if (jsonMode) {
    // Machine-readable output for CI — the only thing on stdout in this mode.
    console.log(JSON.stringify(report, null, 2));
    return !report.failed;
  }

  for (const r of report.results) {
    if (r.status === 'drift') {
      logger.error(`DRIFT ${r.method} ${r.path} (HTTP ${r.httpStatus})`);
      for (const d of r.divergences ?? []) {
        logger.error(`    ${d.path}: ${d.kind} — expected ${d.expected}, got ${d.actual}`);
      }
    } else if (r.status === 'error') {
      logger.warn(`ERROR ${r.method} ${r.path}: ${r.reason}`);
    }
  }

  const { ok, drift, error, skipped } = report.counts;
  logger.info(
    `Live check: ${ok} ok, ${drift} drift, ${error} error, ${skipped} skipped (of ${report.results.length}).`,
  );
  if (report.failed) {
    logger.error('Live verification failed');
    return false;
  }
  logger.success('Live verification passed');
  return true;
}
