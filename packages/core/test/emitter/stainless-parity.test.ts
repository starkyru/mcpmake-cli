import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderTemplate } from '../../src/emitter/template-loader.js';
import { renderWorkerTemplate } from '../../src/emitter/worker-template-loader.js';
import { emitProject, emitWorkerProject } from '../../src/emitter/index.js';
import type { ProjectManifest, ToolDefinition } from '../../src/types/index.js';

/* ─────────────────────────────────────────────────────────────────────────
 * Shared fixtures
 * ───────────────────────────────────────────────────────────────────────── */

function tool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'list_pets',
    title: 'List Pets',
    description: 'List pets',
    inputSchemaCode: 'z.object({ limit: z.number().optional() })',
    operationId: 'listPets',
    method: 'get',
    pathTemplate: '/pets',
    pathParams: [],
    queryParams: ['limit'],
    headerParams: [],
    hasRequestBody: false,
    requestBodyContentType: 'application/json',
    fileName: 'list-pets',
    functionName: 'listPets',
    buildUrlBody: 'return `${baseUrl}/pets`;',
    annotations: { readOnlyHint: true },
    ...over,
  };
}

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    serverName: 'pets-api',
    serverVersion: '1.0.0',
    baseUrl: 'https://api.pets.example.com',
    transport: 'stdio',
    tools: [tool()],
    authSchemes: [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN' }],
    envVars: [{ name: 'BASE_URL', description: 'API base URL', required: true }],
    ...over,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Feature 1 — runtime tool filtering (MCP_TOOLS / MCP_EXCLUDE_TOOLS)
 * ───────────────────────────────────────────────────────────────────────── */

describe('Feature 1: runtime tool filtering', () => {
  it('Node tool-index gates every registration behind isToolEnabled', () => {
    const out = renderTemplate('tool-index.ts', {
      tools: [
        tool({ name: 'list_pets', functionName: 'listPets' }),
        tool({ name: 'delete_pet', functionName: 'deletePet', fileName: 'delete-pet' }),
      ],
    });
    expect(out).toContain('process.env.MCP_TOOLS');
    expect(out).toContain('process.env.MCP_EXCLUDE_TOOLS');
    expect(out).toContain("if (isToolEnabled('list_pets')) registerListPets(server, config);");
    expect(out).toContain("if (isToolEnabled('delete_pet')) registerDeletePet(server, config);");
  });

  it('allowlist wins then denylist removes (logic check)', () => {
    // Mirror the generated isToolEnabled logic to assert the precedence rules.
    const make = (allowRaw?: string, denyRaw?: string) => {
      const parse = (raw?: string) => {
        if (!raw) return undefined;
        const names = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return names.length ? new Set(names) : undefined;
      };
      const allow = parse(allowRaw);
      const deny = parse(denyRaw);
      return (name: string) => {
        if (allow && !allow.has(name)) return false;
        if (deny && deny.has(name)) return false;
        return true;
      };
    };
    // No filters → everything enabled.
    expect(make()('list_pets')).toBe(true);
    // Allowlist.
    const allowOnly = make('list_pets');
    expect(allowOnly('list_pets')).toBe(true);
    expect(allowOnly('delete_pet')).toBe(false);
    // Denylist.
    const denyOnly = make(undefined, 'delete_pet');
    expect(denyOnly('list_pets')).toBe(true);
    expect(denyOnly('delete_pet')).toBe(false);
    // Deny applied after allow.
    const both = make('list_pets,delete_pet', 'delete_pet');
    expect(both('list_pets')).toBe(true);
    expect(both('delete_pet')).toBe(false);
  });

  it('Workers worker.ts filters tools/list, tools/call, and discover by env', () => {
    const out = renderWorkerTemplate('worker.ts', { serverName: 'w', serverVersion: '1.0.0' });
    expect(out).toContain('env.MCP_TOOLS');
    expect(out).toContain('env.MCP_EXCLUDE_TOOLS');
    expect(out).toContain('function enabledTools(env: Env)');
    expect(out).toContain('enabledTools(env).map(toListEntry)');
    expect(out).toContain('!toolEnabled(name, env)');
    expect(out).toContain('count: enabledTools(env).length');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Feature 2 — per-call jq_filter + the minimal jq engine
 * ───────────────────────────────────────────────────────────────────────── */

describe('Feature 2: per-call jq_filter', () => {
  it('every generated tool exposes optional jq_filter / idempotency_key and strips them', () => {
    const out = renderTemplate('tool-handler.ts', tool({ method: 'post', hasRequestBody: true }));
    expect(out).toContain('jq_filter: z');
    expect(out).toContain('idempotency_key: z');
    expect(out).toContain('.extend(controlSchema)');
    // Control args are destructured out of the input before the upstream request.
    expect(out).toContain(
      'const { jq_filter: jqFilter, idempotency_key: idempotencyKey, ...input }',
    );
    expect(out).toContain("import { applyJqFilter } from '../response-filter.js';");
  });

  it('build-time jqFilter and per-call jq_filter coexist (per-call wins)', () => {
    const out = renderTemplate('tool-handler.ts', tool({ jqFilter: 'data.items' }));
    // Build-time filter only runs when no per-call filter is supplied.
    expect(out).toContain("if (typeof jqFilter !== 'string')");
    expect(out).toContain("applyJqFilter(result, 'data.items')");
    // Per-call filter always takes precedence.
    expect(out).toContain("if (typeof jqFilter === 'string' && jqFilter)");
  });
});

describe('Feature 2: minimal jq engine (applyJqFilter, real generated module)', () => {
  let applyJqFilter: (data: unknown, filter: string) => unknown;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpmake-jq-'));
    // Render the real template, transpile TS → JS with esbuild (so the test
    // exercises the actual generated source), then import it.
    const ts = renderTemplate('response-filter.ts', {});
    const { transform } = await import('esbuild');
    const { code } = await transform(ts, { loader: 'ts', format: 'esm' });
    const file = join(dir, 'response-filter.mjs');
    await writeFile(file, code, 'utf-8');
    ({ applyJqFilter } = await import(pathToFileURL(file).href));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('identity returns the whole document', () => {
    expect(applyJqFilter({ a: 1 }, '.')).toEqual({ a: 1 });
    expect(applyJqFilter({ a: 1 }, '')).toEqual({ a: 1 });
  });

  it('nested object access', () => {
    expect(applyJqFilter({ data: { name: 'Rex' } }, '.data.name')).toBe('Rex');
    expect(applyJqFilter({ data: { name: 'Rex' } }, '.data')).toEqual({ name: 'Rex' });
  });

  it('array index (incl. negative) and iteration', () => {
    const doc = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    expect(applyJqFilter(doc, '.items[0].id')).toBe(1);
    expect(applyJqFilter(doc, '.items[-1].id')).toBe(3);
    expect(applyJqFilter(doc, '.items[]')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(applyJqFilter(doc, '.items[].id')).toEqual([1, 2, 3]);
  });

  it('pipe chains stages', () => {
    expect(applyJqFilter({ a: { b: { c: 9 } } }, '.a | .b | .c')).toBe(9);
  });

  it('missing keys yield undefined, never throw', () => {
    expect(applyJqFilter({ a: 1 }, '.nope')).toBeUndefined();
    expect(applyJqFilter({ a: 1 }, '.a.b.c')).toBeUndefined();
  });

  it('unsupported syntax falls back to the unfiltered value (safe)', () => {
    const doc = { a: [1, 2, 3] };
    // Slices / filters / function calls are not supported → return input as-is.
    expect(applyJqFilter(doc, '.a[1:2]')).toEqual(doc);
    expect(applyJqFilter(doc, '.a | map(.x)')).toEqual(doc.a);
    expect(applyJqFilter(doc, 'keys')).toEqual(doc);
  });

  it('tolerates the optional-access "?" marker', () => {
    expect(applyJqFilter({ a: { b: 2 } }, '.a?.b')).toBe(2);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Feature 3 — named environments
 * ───────────────────────────────────────────────────────────────────────── */

describe('Feature 3: named environments', () => {
  it('Node config resolves base URL via MCP_ENVIRONMENTS / API_ENVIRONMENT with BASE_URL fallback', () => {
    const out = renderTemplate('config.ts', manifest());
    expect(out).toContain('function resolveBaseUrl()');
    expect(out).toContain('process.env.MCP_ENVIRONMENTS');
    expect(out).toContain('process.env.API_ENVIRONMENT');
    expect(out).toContain("requireEnv('BASE_URL')");
    expect(out).toContain('baseUrl: resolveBaseUrl(),');
  });

  it('Workers config resolves base URL from the env binding', () => {
    const out = renderWorkerTemplate('config.ts', {
      serverName: 'w',
      authSchemes: [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN' }],
    });
    expect(out).toContain('function resolveBaseUrl(env: EnvLike)');
    expect(out).toContain('env.MCP_ENVIRONMENTS');
    expect(out).toContain('env.API_ENVIRONMENT');
    expect(out).toContain('baseUrl: resolveBaseUrl(env),');
  });

  it('resolver logic: selects a named env, falls back to BASE_URL otherwise', () => {
    // Mirror the generated resolveBaseUrl logic.
    const resolve = (mcpEnvs?: string, selected?: string, baseUrl = 'https://base') => {
      if (mcpEnvs && selected) {
        try {
          const envs = JSON.parse(mcpEnvs);
          const url = envs[selected];
          if (typeof url === 'string' && url) return url.replace(/\/$/, '');
        } catch {
          /* fall through */
        }
      }
      return baseUrl.replace(/\/$/, '');
    };
    const envs = JSON.stringify({ production: 'https://prod', sandbox: 'https://sandbox/' });
    expect(resolve(envs, 'sandbox')).toBe('https://sandbox'); // trailing slash trimmed
    expect(resolve(envs, 'production')).toBe('https://prod');
    expect(resolve(envs, 'unknown')).toBe('https://base'); // unknown name → fallback
    expect(resolve(undefined, 'sandbox')).toBe('https://base'); // no map → fallback
    expect(resolve('not json', 'sandbox')).toBe('https://base'); // malformed → fallback
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Feature 4 — idempotency key + custom default headers
 * ───────────────────────────────────────────────────────────────────────── */

describe('Feature 4: idempotency key + default headers', () => {
  it('http executor accepts an idempotencyKey option and only sets it for mutating methods', () => {
    const out = renderTemplate('http-executor.ts', manifest());
    expect(out).toContain('idempotencyKey?: string;');
    expect(out).toContain("MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])");
    expect(out).toContain('function resolveIdempotencyKey(');
    expect(out).toContain("MCP_IDEMPOTENCY_AUTO === 'true'");
    expect(out).toContain("headers['Idempotency-Key'] = idempotencyKey;");
  });

  it('http executor merges config.defaultHeaders into every request', () => {
    const out = renderTemplate('http-executor.ts', manifest());
    expect(out).toContain('...config.defaultHeaders,');
  });

  it('config parses MCP_DEFAULT_HEADERS into defaultHeaders', () => {
    const out = renderTemplate('config.ts', manifest());
    expect(out).toContain('function loadDefaultHeaders()');
    expect(out).toContain('process.env.MCP_DEFAULT_HEADERS');
    expect(out).toContain('defaultHeaders: loadDefaultHeaders(),');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * End-to-end: a fully emitted project carries the new modules + docs
 * ───────────────────────────────────────────────────────────────────────── */

describe('emitProject wires the new runtime knobs', () => {
  let dir: string;
  const read = (rel: string) => readFile(join(dir, rel), 'utf-8');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpmake-parity-'));
    await emitProject(manifest({ transport: 'http' }), {
      outputDir: dir,
      force: true,
      dryRun: false,
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits src/response-filter.ts', async () => {
    expect(await read('src/response-filter.ts')).toContain('export function applyJqFilter');
  });

  it('documents the new env vars in .env.example and README', async () => {
    const env = await read('.env.example');
    expect(env).toContain('MCP_TOOLS');
    expect(env).toContain('MCP_EXCLUDE_TOOLS');
    expect(env).toContain('MCP_ENVIRONMENTS');
    expect(env).toContain('API_ENVIRONMENT');
    expect(env).toContain('MCP_DEFAULT_HEADERS');
    expect(env).toContain('MCP_IDEMPOTENCY_AUTO');

    const readme = await read('README.md');
    expect(readme).toContain('Named environments');
    expect(readme).toContain('Runtime tool filtering');
    expect(readme).toContain('jq_filter');
    expect(readme).toContain('idempotency_key');
  });
});

describe('emitWorkerProject wires the new runtime knobs', () => {
  let dir: string;
  const read = (rel: string) => readFile(join(dir, rel), 'utf-8');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpmake-parity-worker-'));
    await emitWorkerProject(manifest({ target: 'cloudflare', transport: 'http' }), {
      outputDir: dir,
      force: true,
      dryRun: false,
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits src/response-filter.ts for the Workers target', async () => {
    expect(await read('src/response-filter.ts')).toContain('export function applyJqFilter');
  });

  it('Workers tool handler imports the filter and strips control args', async () => {
    const handler = await read('src/tools/list-pets.ts');
    expect(handler).toContain("import { applyJqFilter } from '../response-filter.js';");
    expect(handler).toContain('.extend(controlSchema)');
    expect(handler).toContain(
      'const { jq_filter: jqFilter, idempotency_key: idempotencyKey, ...input }',
    );
  });
});
