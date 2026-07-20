/**
 * 2026-07-28 RC behaviors are held behind the generated-server feature-flag
 * subsystem (src/flags.ts) until the spec + official SDK are final:
 *   - handshake-less requests (initialize removal) via a synthetic initialize
 *     shim on the pinned SDK (Node HTTP target),
 *   - per-request `params._meta` (protocolVersion/clientInfo/capabilities),
 *   - RC protocol-version negotiation (Worker target).
 * All of it must be OFF by default — these tests pin the emitted wiring and the
 * fail-closed defaults. Runtime behavior against a real SDK install is covered
 * by the E2E_HEAVY tier (generated-compile / parity).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitProject, emitWorkerProject } from '../../src/emitter/index.js';
import { pathExists } from '../../src/utils/fs.js';
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
    ...over,
  };
}

describe('generated-server feature flags — Node HTTP target', () => {
  let dir: string;
  const read = (rel: string) => readFile(join(dir, rel), 'utf-8');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpmake-rcflag-'));
    await emitProject(manifest(), { outputDir: dir, force: true, dryRun: false });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits the flags subsystem with the RC flag off by default', async () => {
    const flags = await read('src/flags.ts');
    expect(flags).toContain("name: 'protocol-2026-07-28'");
    expect(flags).toContain("env: 'MCP_FEATURE_PROTOCOL_2026_07_28'");
    expect(flags).toContain('default: false');
    // Unknown names fail closed (warn + ignore), never enable.
    expect(flags).toContain('ignored');
    expect(flags).toContain('MCP_FEATURES');
  });

  it('gates the handshake-less shim + per-request _meta behind the flag', async () => {
    const index = await read('src/index.ts');
    expect(index).toContain("import { flags, enabledFlagNames } from './flags.js'");
    // The synthetic-initialize shim only runs when the flag is on and the
    // request is not itself an initialize.
    expect(index).toContain('flags.protocol20260728 && !isInitializeRequest(parsedBody)');
    expect(index).toContain('primeInitialized(transport, extractRequestMeta(parsedBody))');
    // The shim completes the SDK handshake state (initialize + initialized).
    expect(index).toContain('__mcpmake_synthetic_init__');
    expect(index).toContain("method: 'notifications/initialized'");
    // _meta extraction covers the three RC-moved handshake fields.
    expect(index).toContain('protocolVersion');
    expect(index).toContain('clientInfo');
    // Enabled flags surface in server/discover and the boot log.
    expect(index).toContain('features: enabledFlagNames(flags)');
    // Stateful mode still requires the handshake — warned, not silently ignored.
    expect(index).toContain('has no effect in MCP_STATEFUL=true');
  });

  it('documents the knobs in .env.example and the README', async () => {
    const env = await read('.env.example');
    expect(env).toContain('MCP_FEATURES=protocol-2026-07-28');
    expect(env).toContain('MCP_FEATURE_PROTOCOL_2026_07_28');
    const readme = await read('README.md');
    expect(readme).toContain('Feature flags');
    expect(readme).toContain('protocol-2026-07-28');
    expect(readme).toContain('off by default');
  });
});

describe('generated-server feature flags — stdio target emits none', () => {
  it('does not emit src/flags.ts for a stdio server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcpmake-rcflag-stdio-'));
    try {
      await emitProject(manifest({ transport: 'stdio' }), {
        outputDir: dir,
        force: true,
        dryRun: false,
      });
      expect(await pathExists(join(dir, 'src/flags.ts'))).toBe(false);
      const index = await readFile(join(dir, 'src/index.ts'), 'utf-8');
      expect(index).not.toContain('./flags.js');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('generated-server feature flags — Cloudflare Worker target', () => {
  let dir: string;
  const read = (rel: string) => readFile(join(dir, rel), 'utf-8');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpmake-rcflag-worker-'));
    await emitWorkerProject(manifest({ target: 'cloudflare' }), {
      outputDir: dir,
      force: true,
      dryRun: false,
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mirrors the flag knobs and negotiates the RC version only when enabled', async () => {
    const worker = await read('src/index.ts');
    expect(worker).toContain("const RC_FEATURE_NAME = 'protocol-2026-07-28'");
    expect(worker).toContain('MCP_FEATURE_PROTOCOL_2026_07_28');
    // RC version joins the negotiable set only behind the flag.
    expect(worker).toContain('rcFlagEnabled(env)');
    expect(worker).toContain('[...SUPPORTED_PROTOCOL_VERSIONS, PROTOCOL_REVISION]');
    // Per-request _meta is honored (logged) behind the flag.
    expect(worker).toContain('per-request _meta');
    // discover advertises enabled flags.
    expect(worker).toContain('features: rcFlagEnabled(env) ? [RC_FEATURE_NAME] : []');
  });

  it('documents the knobs in .dev.vars.example', async () => {
    const devVars = await read('.dev.vars.example');
    expect(devVars).toContain('MCP_FEATURES=protocol-2026-07-28');
    expect(devVars).toContain('MCP_FEATURE_PROTOCOL_2026_07_28');
  });
});
