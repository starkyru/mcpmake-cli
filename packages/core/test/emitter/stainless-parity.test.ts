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
    paramMappings: [{ inputKey: 'limit', wireName: 'limit', in: 'query' }],
    hasRequestBody: false,
    requestBodyContentType: 'application/json',
    buildHeadersBody: '  return {};',
    operationMeta: '{"method":"get","path":"/pets"}',
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

  it('REAL generated isToolEnabled: allowlist gates, denylist removes after allow', async () => {
    // Render the actual tool-index.ts.hbs, transpile TS → JS, and import the
    // GENERATED isToolEnabled (no hand-copy of the logic). The module binds
    // allow/deny from process.env at load time, so each scenario is a fresh
    // import after setting the env — that exercises parseList + the precedence
    // rules in the real source, not a mirror of them.
    const dir = await mkdtemp(join(tmpdir(), 'mcpmake-toolfilter-'));
    try {
      const ts = renderTemplate('tool-index.ts', { tools: [] });
      const { transform } = await import('esbuild');
      const { code } = await transform(ts, { loader: 'ts', format: 'esm' });

      const saved = { allow: process.env.MCP_TOOLS, deny: process.env.MCP_EXCLUDE_TOOLS };
      let seq = 0;
      const load = async (
        allow: string | undefined,
        deny: string | undefined,
      ): Promise<(name: string) => boolean> => {
        if (allow === undefined) delete process.env.MCP_TOOLS;
        else process.env.MCP_TOOLS = allow;
        if (deny === undefined) delete process.env.MCP_EXCLUDE_TOOLS;
        else process.env.MCP_EXCLUDE_TOOLS = deny;
        // The generated module binds allow/deny from process.env at load time,
        // so each scenario needs a genuinely fresh module. Write to a unique
        // path per scenario (query-string cache-busting is unreliable under the
        // test runner's module cache) so process.env is re-read every time.
        const file = join(dir, `tool-index-${seq++}.mjs`);
        await writeFile(file, code, 'utf-8');
        const mod = await import(pathToFileURL(file).href);
        return mod.isToolEnabled as (name: string) => boolean;
      };

      try {
        // No filters → everything enabled.
        const none = await load(undefined, undefined);
        expect(none('list_pets')).toBe(true);
        expect(none('delete_pet')).toBe(true);

        // Allowlist: only listed names register, everything else is gated off.
        const allowOnly = await load('list_pets', undefined);
        expect(allowOnly('list_pets')).toBe(true);
        expect(allowOnly('delete_pet')).toBe(false);

        // Denylist: listed names never register, the rest stay enabled.
        const denyOnly = await load(undefined, 'delete_pet');
        expect(denyOnly('list_pets')).toBe(true);
        expect(denyOnly('delete_pet')).toBe(false);

        // Precedence: deny is applied AFTER allow. A name on BOTH lists is
        // removed — proving deny wins over allow (the bug a flipped template
        // would introduce: allow-after-deny would keep delete_pet enabled).
        const both = await load('list_pets,delete_pet', 'delete_pet');
        expect(both('list_pets')).toBe(true);
        expect(both('delete_pet')).toBe(false);

        // A name absent from a non-empty allowlist is rejected even if it is
        // not on the denylist (allowlist is a strict membership gate).
        const allowExcludesUnknown = await load('list_pets', 'something_else');
        expect(allowExcludesUnknown('delete_pet')).toBe(false);

        // parseList tolerance: surrounding whitespace and empty entries are
        // trimmed/dropped, so a sloppy env value still matches by exact name.
        const sloppy = await load('  list_pets , , delete_pet ', undefined);
        expect(sloppy('list_pets')).toBe(true);
        expect(sloppy('delete_pet')).toBe(true);
        expect(sloppy('other')).toBe(false);

        // A whitespace-only allowlist parses to undefined → treated as "no
        // filter", so it must NOT gate everything off.
        const blank = await load('   ', undefined);
        expect(blank('list_pets')).toBe(true);
      } finally {
        if (saved.allow === undefined) delete process.env.MCP_TOOLS;
        else process.env.MCP_TOOLS = saved.allow;
        if (saved.deny === undefined) delete process.env.MCP_EXCLUDE_TOOLS;
        else process.env.MCP_EXCLUDE_TOOLS = saved.deny;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('REAL generated resolveBaseUrl: named env selection + BASE_URL fallback', async () => {
    // Render the actual config.ts.hbs, transpile, and import the GENERATED
    // module. resolveBaseUrl is internal, but loadConfig() returns its result as
    // `baseUrl`, so calling the exported loadConfig exercises the real resolver
    // (JSON.parse, envs[selected], trailing-slash trim, the malformed-JSON
    // catch, the unknown-name fallback) — no hand-copied mirror.
    const dir = await mkdtemp(join(tmpdir(), 'mcpmake-resolver-'));
    try {
      const ts = renderTemplate('config.ts', manifest());
      const { transform } = await import('esbuild');
      const { code } = await transform(ts, { loader: 'ts', format: 'esm' });
      const file = join(dir, 'config.mjs');
      await writeFile(file, code, 'utf-8');
      const { loadConfig } = (await import(pathToFileURL(file).href)) as {
        loadConfig: () => { baseUrl: string };
      };

      const saved = {
        envs: process.env.MCP_ENVIRONMENTS,
        sel: process.env.API_ENVIRONMENT,
        base: process.env.BASE_URL,
      };
      const resolved = (
        mcpEnvs: string | undefined,
        selected: string | undefined,
        baseUrl: string | undefined,
      ): string => {
        if (mcpEnvs === undefined) delete process.env.MCP_ENVIRONMENTS;
        else process.env.MCP_ENVIRONMENTS = mcpEnvs;
        if (selected === undefined) delete process.env.API_ENVIRONMENT;
        else process.env.API_ENVIRONMENT = selected;
        if (baseUrl === undefined) delete process.env.BASE_URL;
        else process.env.BASE_URL = baseUrl;
        return loadConfig().baseUrl;
      };

      const envs = JSON.stringify({ production: 'https://prod', sandbox: 'https://sandbox/' });
      try {
        // Named env selected → its URL, trailing slash trimmed.
        expect(resolved(envs, 'sandbox', 'https://base')).toBe('https://sandbox');
        expect(resolved(envs, 'production', 'https://base')).toBe('https://prod');
        // Unknown name → BASE_URL fallback (also trailing-slash trimmed).
        expect(resolved(envs, 'unknown', 'https://base/')).toBe('https://base');
        // No env map / no selection → BASE_URL.
        expect(resolved(undefined, 'sandbox', 'https://base')).toBe('https://base');
        expect(resolved(envs, undefined, 'https://base')).toBe('https://base');
        // Malformed MCP_ENVIRONMENTS → the try/catch swallows it → BASE_URL.
        expect(resolved('not json', 'sandbox', 'https://base')).toBe('https://base');
        // Non-string mapped value (e.g. a number) → fall through to BASE_URL.
        expect(resolved(JSON.stringify({ sandbox: 123 }), 'sandbox', 'https://base')).toBe(
          'https://base',
        );
        // Empty-string mapped value → falsy, so fall through to BASE_URL.
        expect(resolved(JSON.stringify({ sandbox: '' }), 'sandbox', 'https://base')).toBe(
          'https://base',
        );
        // Missing BASE_URL with no usable env → requireEnv throws.
        expect(() => resolved(undefined, undefined, undefined)).toThrow(/BASE_URL/);
      } finally {
        const restore = (k: string, v: string | undefined) => {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        };
        restore('MCP_ENVIRONMENTS', saved.envs);
        restore('API_ENVIRONMENT', saved.sel);
        restore('BASE_URL', saved.base);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('http executor caps Retry-After at 60 s and guards against NaN (HTTP-date form)', () => {
    const out = renderTemplate('http-executor.ts', manifest());
    // Delay is bounded: Math.min(retryAfterMs, 60_000) prevents DoS from huge values.
    expect(out).toContain('Math.min(retryAfterMs, 60_000)');
    // NaN guard: only honor the header when the parsed value is a finite number.
    expect(out).toContain('Number.isFinite(retryAfterMs)');
  });

  it('config parses MCP_DEFAULT_HEADERS into defaultHeaders', () => {
    const out = renderTemplate('config.ts', manifest());
    expect(out).toContain('function loadDefaultHeaders()');
    expect(out).toContain('process.env.MCP_DEFAULT_HEADERS');
    expect(out).toContain('defaultHeaders: loadDefaultHeaders(),');
  });

  it('REAL generated loadDefaultHeaders: parses JSON, drops non-strings, fails safe', async () => {
    // Behavioral companion to the structural check above: exercise the GENERATED
    // loadDefaultHeaders (via the exported loadConfig().defaultHeaders), so a
    // regression in the parser — dropping the non-string filter or the
    // malformed-JSON catch — would actually fail here.
    const dir = await mkdtemp(join(tmpdir(), 'mcpmake-headers-'));
    try {
      const ts = renderTemplate('config.ts', manifest());
      const { transform } = await import('esbuild');
      const { code } = await transform(ts, { loader: 'ts', format: 'esm' });
      const file = join(dir, 'config.mjs');
      await writeFile(file, code, 'utf-8');
      const { loadConfig } = (await import(pathToFileURL(file).href)) as {
        loadConfig: () => { defaultHeaders: Record<string, string> };
      };

      const saved = { hdrs: process.env.MCP_DEFAULT_HEADERS, base: process.env.BASE_URL };
      process.env.BASE_URL = 'https://base';
      delete process.env.MCP_ENVIRONMENTS;
      delete process.env.API_ENVIRONMENT;
      const headersFor = (raw: string | undefined): Record<string, string> => {
        if (raw === undefined) delete process.env.MCP_DEFAULT_HEADERS;
        else process.env.MCP_DEFAULT_HEADERS = raw;
        return loadConfig().defaultHeaders;
      };

      try {
        // Unset → empty map (non-breaking default).
        expect(headersFor(undefined)).toEqual({});
        // Valid JSON object of string values → passed through verbatim.
        expect(headersFor(JSON.stringify({ 'X-A': 'a', 'X-B': 'b' }))).toEqual({
          'X-A': 'a',
          'X-B': 'b',
        });
        // Non-string values are dropped; string siblings survive.
        expect(
          headersFor(JSON.stringify({ 'X-Str': 'ok', 'X-Num': 5, 'X-Obj': { k: 1 } })),
        ).toEqual({ 'X-Str': 'ok' });
        // Malformed JSON → caught → empty map (never throws).
        expect(headersFor('not json')).toEqual({});
      } finally {
        if (saved.hdrs === undefined) delete process.env.MCP_DEFAULT_HEADERS;
        else process.env.MCP_DEFAULT_HEADERS = saved.hdrs;
        if (saved.base === undefined) delete process.env.BASE_URL;
        else process.env.BASE_URL = saved.base;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
