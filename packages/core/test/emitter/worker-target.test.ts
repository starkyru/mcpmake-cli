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
