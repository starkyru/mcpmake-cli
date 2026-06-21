import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitProject, emitWorkerProject } from '../../src/emitter/index.js';
import type { ProjectManifest, ToolDefinition } from '../../src/types/index.js';

function tool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'list_widgets',
    title: 'List Widgets',
    description: 'List widgets',
    inputSchemaCode: 'z.object({ limit: z.number().optional() })',
    operationId: 'listWidgets',
    method: 'get',
    pathTemplate: '/widgets',
    pathParams: [],
    queryParams: ['limit'],
    headerParams: [],
    paramMappings: [{ inputKey: 'limit', wireName: 'limit', in: 'query' }],
    hasRequestBody: false,
    requestBodyContentType: 'application/json',
    buildHeadersBody: '  return {};',
    operationMeta: '{"method":"get","path":"/widgets"}',
    fileName: 'list-widgets',
    functionName: 'listWidgets',
    buildUrlBody: 'return `${baseUrl}/widgets`;',
    annotations: { readOnlyHint: true },
    ...over,
  };
}

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    serverName: 'widget-api',
    serverVersion: '2.0.0',
    baseUrl: 'https://api.widgets.example.com',
    transport: 'http',
    tools: [tool()],
    authSchemes: [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN' }],
    envVars: [
      { name: 'BASE_URL', description: 'API base URL', required: true },
      { name: 'BEARER_TOKEN', description: 'Bearer token', required: true },
    ],
    target: 'cloudflare',
    ...over,
  };
}

describe('emitWorkerProject — Cloudflare Workers target', () => {
  let dir: string;
  let files: string[];
  const read = (rel: string) => readFile(join(dir, rel), 'utf-8');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpmake-worker-'));
    await emitWorkerProject(manifest(), { outputDir: dir, force: true, dryRun: false });
    const walk = async (d: string, base = ''): Promise<string[]> => {
      const out: string[] = [];
      for (const ent of await readdir(join(dir, d), { withFileTypes: true })) {
        const rel = base ? `${base}/${ent.name}` : ent.name;
        if (ent.isDirectory()) out.push(...(await walk(join(d, ent.name), rel)));
        else out.push(rel);
      }
      return out;
    };
    files = await walk('');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits the Workers project skeleton (wrangler, no Dockerfile)', () => {
    expect(files).toContain('wrangler.toml');
    expect(files).toContain('package.json');
    expect(files).toContain('tsconfig.json');
    expect(files).toContain('.dev.vars.example');
    expect(files).toContain('src/index.ts');
    expect(files).toContain('src/tools/index.ts');
    expect(files).toContain('src/tools/list-widgets.ts');
    // Reused runtime-agnostic modules.
    expect(files).toContain('src/http.ts');
    expect(files).toContain('src/auth.ts');
    expect(files).toContain('src/trace.ts');
    // Node-only artifacts must NOT be emitted.
    expect(files).not.toContain('Dockerfile');
  });

  it('entry is a Fetch handler, not the node:http SDK transport', async () => {
    const entry = await read('src/index.ts');
    expect(entry).toContain('async fetch(request: Request, env: Env)');
    expect(entry).toContain("case 'tools/list'");
    expect(entry).toContain("case 'tools/call'");
    expect(entry).toContain("case 'server/discover'");
    expect(entry).toContain('isAuthorized');
    // The hand-rolled dispatcher imports neither the SDK nor node:http.
    expect(entry).not.toContain('@modelcontextprotocol/sdk');
    expect(entry).not.toContain('new StreamableHTTPServerTransport');
    expect(entry).not.toContain("from 'node:http'");
  });

  it('wrangler.toml requires nodejs_compat and carries BASE_URL + secret hints', async () => {
    const toml = await read('wrangler.toml');
    expect(toml).toContain('compatibility_flags = ["nodejs_compat"]');
    expect(toml).toContain('main = "src/index.ts"');
    expect(toml).toContain('BASE_URL = "https://api.widgets.example.com"');
    expect(toml).toContain('wrangler secret put MCP_AUTH_TOKEN');
    expect(toml).toContain('wrangler secret put BEARER_TOKEN');
  });

  it('package.json targets Workers (wrangler + zod-to-json-schema, no SDK)', async () => {
    const pkg = JSON.parse(await read('package.json'));
    expect(pkg.dependencies['zod-to-json-schema']).toBeTruthy();
    expect(pkg.devDependencies['wrangler']).toBeTruthy();
    expect(pkg.devDependencies['@cloudflare/workers-types']).toBeTruthy();
    expect(pkg.scripts.deploy).toContain('wrangler');
    // The hand-rolled dispatcher means no SDK dependency.
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
  });

  it('tool file exports a definition + handler (no SDK server registration)', async () => {
    const t = await read('src/tools/list-widgets.ts');
    expect(t).toContain('export const definition');
    expect(t).toContain('export async function handler');
    expect(t).toContain('executeRequest');
    expect(t).not.toContain('registerTool');
  });

  it('config reads from the env binding, not process.env', async () => {
    const cfg = await read('src/config.ts');
    expect(cfg).toContain('loadConfig(env: EnvLike)');
    expect(cfg).toContain('env.BEARER_TOKEN');
    expect(cfg).not.toContain('process.env');
  });

  it('R4-C(a): handleToolCall wraps entry.handler in try/catch and returns a JSON-RPC error on throw', async () => {
    const entry = await read('src/index.ts');
    // The handler invocation must be inside a try block.
    expect(entry).toMatch(/try \{[\s\S]*?entry\.handler\(/);
    // A caught throw returns an err() call with code -32000, not a raw throw.
    expect(entry).toContain("return err(id, -32000, 'Tool execution error')");
    // The raw error is NOT forwarded to the client (no `e.message` / `err.message` in catch).
    expect(entry).not.toMatch(/catch\s*\(\s*\w+\s*\)[\s\S]{0,60}\.message/);
  });

  it('negotiates the initialize protocol version instead of blindly echoing it', async () => {
    const entry = await read('src/index.ts');
    // Preferred = current stable; a supported set is checked, not echoed.
    expect(entry).toContain("const PROTOCOL_VERSION = '2025-11-25'");
    expect(entry).toContain('SUPPORTED_PROTOCOL_VERSIONS');
    expect(entry).toContain('SUPPORTED_PROTOCOL_VERSIONS.includes(requested)');
    // The old blind-echo form must be gone.
    expect(entry).not.toContain(
      "protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION",
    );
  });

  it('fails CLOSED when MCP_AUTH_TOKEN is unset and no explicit opt-in (L-authoff)', async () => {
    const entry = await read('src/index.ts');
    // Auth reads the secret from the env binding (Worker secret), not process.env.
    expect(entry).toContain('const expected = env.MCP_AUTH_TOKEN;');
    expect(entry).not.toMatch(/process\.env\.MCP_AUTH_TOKEN/);
    // The old open-by-default form is gone…
    expect(entry).not.toContain('if (!expected) return true;');
    // …replaced by an explicit dev-only opt-in via the matching env name.
    expect(entry).toContain("env.MCP_ALLOW_UNAUTHENTICATED === 'true'");
    // Default branch (no token, no opt-in) denies and warns loudly.
    expect(entry).toContain('denying all authenticated routes');
    expect(entry).toContain('WITHOUT a bearer token');
    // /health and /ready stay open: their branches precede the auth gate.
    const authIdx = entry.indexOf('isAuthorized(request, env)');
    const healthIdx = entry.indexOf("url.pathname === '/health'");
    const readyIdx = entry.indexOf("url.pathname === '/ready'");
    expect(healthIdx).toBeGreaterThan(-1);
    expect(healthIdx).toBeLessThan(authIdx);
    expect(readyIdx).toBeLessThan(authIdx);
  });

  it('never blanket-* CORS on credentialed responses; reflects only allowlisted origins (L-cors)', async () => {
    const entry = await read('src/index.ts');
    // The wildcard fallback is gone everywhere.
    expect(entry).not.toContain("origin || '*'");
    expect(entry).not.toMatch(/['"]access-control-allow-origin['"]\s*:\s*['"]\*['"]/);
    // Reflection is gated by a comma-separated allowlist env var.
    expect(entry).toContain('MCP_ALLOWED_ORIGINS');
    // When an origin is allowed it is echoed verbatim with Vary: Origin.
    expect(entry).toContain("headers['access-control-allow-origin'] = origin as string;");
    expect(entry).toContain("headers['vary'] = 'Origin';");
    // The 401 response carries the (possibly empty) per-request CORS headers, not '*'.
    const unauthIdx = entry.indexOf('Unauthorized: missing or invalid bearer token');
    const unauthBlock = entry.slice(unauthIdx, unauthIdx + 200);
    expect(unauthBlock).toContain('...cors');
  });

  it('omits resources and prompts on the Workers target', async () => {
    const d = await mkdtemp(join(tmpdir(), 'mcpmake-worker-rp-'));
    try {
      await emitWorkerProject(
        manifest({
          resources: [{ name: 'r', uri: 'u', path: '/r', description: 'd' }],
          prompts: [{ name: 'p', description: 'd', template: 't' }],
        }),
        { outputDir: d, force: true, dryRun: false },
      );
      const present = await readdir(join(d, 'src'));
      expect(present).not.toContain('resources.ts');
      expect(present).not.toContain('prompts.ts');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('emitProject — target delegation', () => {
  it('routes target=cloudflare to the Workers pipeline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcpmake-worker-del-'));
    try {
      await emitProject(manifest(), { outputDir: dir, force: true, dryRun: false });
      const entry = await readFile(join(dir, 'src/index.ts'), 'utf-8');
      expect(entry).toContain('async fetch(request: Request, env: Env)');
      // node target artifacts absent
      await expect(readFile(join(dir, 'Dockerfile'), 'utf-8')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still emits a Node server when target is node/undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcpmake-node-'));
    try {
      await emitProject(manifest({ target: 'node' }), {
        outputDir: dir,
        force: true,
        dryRun: false,
      });
      const entry = await readFile(join(dir, 'src/index.ts'), 'utf-8');
      expect(entry).toContain("from 'node:http'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
