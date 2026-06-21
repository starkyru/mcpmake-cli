import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { buildToolDefinition } from '../../src/transformer/tool-builder.js';
import { renderTemplate } from '../../src/emitter/template-loader.js';
import { renderWorkerTemplate } from '../../src/emitter/worker-template-loader.js';
import { detectAuthSchemes } from '../../src/transformer/auth-detector.js';
import { emitProject, emitWorkerProject, emitPythonProject } from '../../src/emitter/index.js';
import type {
  OperationDescriptor,
  ProjectManifest,
  AuthScheme,
  ToolDefinition,
} from '../../src/types/index.js';

/** Transpile rendered TS and fail on any syntactic diagnostic. */
function assertParses(source: string, label: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const syntactic = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  const msgs = syntactic
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    .join('; ');
  expect(syntactic, `${label} did not parse: ${msgs}`).toHaveLength(0);
}

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'listPets',
    method: 'get',
    path: '/pets',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

const QUERY_API_KEY: AuthScheme = {
  type: 'apiKey',
  envVarName: 'API_KEY',
  headerName: 'api_key',
  in: 'query',
  schemeName: 'apiKeyQuery',
};

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  const tool = buildToolDefinition(makeOp());
  return {
    serverName: 'pet-api',
    serverVersion: '1.0.0',
    baseUrl: 'https://api.example.com',
    transport: 'stdio',
    tools: [tool],
    authSchemes: [QUERY_API_KEY],
    envVars: [
      { name: 'BASE_URL', description: 'base', required: false },
      { name: 'API_KEY', description: 'api key', required: true },
    ],
    ...over,
  };
}

function withTmp(fn: (dir: string) => Promise<void> | void): Promise<void> {
  return (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpmake-auth-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

describe('D-H2 — query API-key auth (end to end)', () => {
  it('threads apiKeyQueryName through config and appends it during URL construction (node)', async () => {
    await withTmp(async (dir) => {
      await emitProject(manifest(), { outputDir: dir, force: true, dryRun: false });
      const config = readFileSync(join(dir, 'src/config.ts'), 'utf-8');
      const auth = readFileSync(join(dir, 'src/auth.ts'), 'utf-8');
      const handler = readFileSync(join(dir, 'src/tools/list-pets.ts'), 'utf-8');

      // Config carries the query-param name and reads the key env var.
      expect(config).toContain('apiKeyQueryName?: string');
      expect(config).toContain('apiKeyQueryName: "api_key"');
      // The query key is NOT applied as a header in getAuthHeaders.
      expect(auth).not.toContain("headers['api_key']");
      // getAuthQueryParams exposes the query key; handler appends it to the URL.
      expect(auth).toContain('export function getAuthQueryParams');
      expect(auth).toContain('params[config.apiKeyQueryName] = config.apiKey');
      expect(handler).toContain("import { getAuthQueryParams } from '../auth.js'");
      expect(handler).toContain('url = appendQueryParams(url, getAuthQueryParams(config');
      assertParses(handler, 'node query-auth handler');
      assertParses(auth, 'node auth-provider');
    });
  });

  it('appends the query API-key on the Workers target too', async () => {
    await withTmp(async (dir) => {
      await emitWorkerProject(manifest({ target: 'cloudflare', transport: 'http' }), {
        outputDir: dir,
        force: true,
        dryRun: false,
      });
      const handler = readFileSync(join(dir, 'src/tools/list-pets.ts'), 'utf-8');
      const config = readFileSync(join(dir, 'src/config.ts'), 'utf-8');
      expect(config).toContain('apiKeyQueryName: "api_key"');
      expect(handler).toContain('url = appendQueryParams(url, getAuthQueryParams(config');
      assertParses(handler, 'worker query-auth handler');
    });
  });

  it('appends the query API-key into the request params (python)', async () => {
    await withTmp(async (dir) => {
      await emitPythonProject(manifest(), { outputDir: dir, force: true, dryRun: false });
      const py = readFileSync(join(dir, 'server.py'), 'utf-8');
      // The query key must be a query param, never a header.
      expect(py).toContain('def _auth_query_params()');
      expect(py).toContain('params["api_key"] = API_KEY');
      expect(py).not.toContain('headers["api_key"]');
      expect(py).toContain('params=params');
    });
  });

  it('handlers are byte-for-byte unaffected when there is no query API-key', async () => {
    const tool = buildToolDefinition(makeOp());
    const noQueryAuth = renderTemplate('tool-handler.ts', {
      ...tool,
      hasQueryApiKey: false,
    });
    expect(noQueryAuth).not.toContain('getAuthQueryParams');
    expect(noQueryAuth).not.toContain('appendQueryParams');
    // The plain assignment form is preserved (not the let/append form).
    expect(noQueryAuth).toContain('const url = buildUrl(input, config.baseUrl)');
  });
});

describe('D-H2 — cookie API-key auth', () => {
  it('appends the cookie API-key onto the Cookie header at request time (node)', async () => {
    const cookieAuth: AuthScheme = {
      type: 'apiKey',
      envVarName: 'API_KEY',
      headerName: 'sid',
      in: 'cookie',
      schemeName: 'apiKeyCookie',
    };
    await withTmp(async (dir) => {
      await emitProject(manifest({ authSchemes: [cookieAuth] }), {
        outputDir: dir,
        force: true,
        dryRun: false,
      });
      const auth = readFileSync(join(dir, 'src/auth.ts'), 'utf-8');
      expect(auth).toContain("const pair = 'sid=' + encodeURIComponent(config.apiKey)");
      expect(auth).toContain("headers['Cookie'] = existing ? existing + '; ' + pair : pair");
      assertParses(auth, 'cookie auth-provider');
    });
  });
});

describe('D-H2 — per-operation security semantics', () => {
  function authReqOf(op: OperationDescriptor): ToolDefinition['authRequirement'] {
    return buildToolDefinition(op).authRequirement;
  }

  it('an operation with explicit security:[] is public (no auth requirement applied)', () => {
    const tool = buildToolDefinition(makeOp({ securityOptional: true }));
    expect(tool.authRequirement).toEqual({ mode: 'public' });
    const handler = renderTemplate('tool-handler.ts', { ...tool, hasQueryApiKey: true });
    // The public requirement is forwarded so getAuthHeaders / getAuthQueryParams
    // can skip every scheme.
    expect(handler).toContain('authRequirement: {"mode":"public"}');
    assertParses(handler, 'public-op handler');
  });

  it('an operation listing a specific scheme selects only that scheme', () => {
    const req = authReqOf(makeOp({ security: [{ schemeName: 'bearerAuth', scopes: [] }] }));
    expect(req).toEqual({ mode: 'schemes', schemeNames: ['bearerAuth'] });
  });

  it('de-duplicates repeated scheme names (OR/AND collapsed to a union)', () => {
    const req = authReqOf(
      makeOp({
        security: [
          { schemeName: 'a', scopes: [] },
          { schemeName: 'b', scopes: [] },
          { schemeName: 'a', scopes: ['x'] },
        ],
      }),
    );
    expect(req).toEqual({ mode: 'schemes', schemeNames: ['a', 'b'] });
  });

  it('no declared security keeps the legacy global behavior (undefined requirement)', () => {
    expect(authReqOf(makeOp())).toBeUndefined();
  });

  it('getAuthHeaders gates each scheme by name via schemeApplies', async () => {
    await withTmp(async (dir) => {
      await emitProject(
        manifest({
          authSchemes: [
            { type: 'http-bearer', envVarName: 'BEARER_TOKEN', schemeName: 'bearerAuth' },
          ],
          tools: [buildToolDefinition(makeOp({ securityOptional: true }))],
        }),
        { outputDir: dir, force: true, dryRun: false },
      );
      const auth = readFileSync(join(dir, 'src/auth.ts'), 'utf-8');
      expect(auth).toContain('function schemeApplies');
      expect(auth).toContain('schemeApplies(requirement, "bearerAuth")');
      assertParses(auth, 'scheme-gated auth-provider');
    });
  });
});

describe('D-H2 — python header / cookie request params', () => {
  it('emits sanitized header/cookie args mapped to original wire names', () => {
    const tool = buildToolDefinition(
      makeOp({
        operationId: 'h',
        path: '/h',
        parameters: [
          { name: 'X-Tenant-Id', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'session-id', in: 'cookie', required: false, schema: { type: 'string' } },
        ],
      }),
    );
    return withTmp(async (dir) => {
      await emitPythonProject(
        {
          serverName: 'h-api',
          serverVersion: '1.0.0',
          baseUrl: 'https://api.example.com',
          transport: 'stdio',
          tools: [tool],
          authSchemes: [],
          envVars: [{ name: 'BASE_URL', description: 'base', required: false }],
        },
        { outputDir: dir, force: true, dryRun: false },
      );
      const py = readFileSync(join(dir, 'server.py'), 'utf-8');
      // Hyphenated names become valid, de-duplicated Python identifiers in the sig.
      expect(py).toMatch(/X_Tenant_Id: str = ""/);
      expect(py).toMatch(/session_id: str = ""/);
      // The upstream request uses the ORIGINAL wire names.
      expect(py).toContain('req_headers["X-Tenant-Id"] = X_Tenant_Id');
      expect(py).toContain('_cookie_parts.append("session-id=" + quote(str(session_id)');
      expect(py).toContain('req_headers["Cookie"]');
    });
  });
});

// ---------------------------------------------------------------------------
// R23-C — dual apiKey scheme must not produce duplicate `apiKey` property
// ---------------------------------------------------------------------------
// transpileModule strips type information so TS2300 "Duplicate identifier" is
// invisible to it. These tests assert the structural invariant directly: count
// occurrences of the relevant property strings in the rendered output.
describe('R23-C — dual apiKey config dedup (node + worker templates)', () => {
  /**
   * Return schemes already annotated with `emitApiKeyValue` by detectAuthSchemes
   * so the template context mirrors what the real emitter pipeline produces.
   */
  function dualApiKeySchemes() {
    const { authSchemes } = detectAuthSchemes({
      HeaderKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
    });
    return authSchemes;
  }

  it('node config.ts AppConfig has exactly one `apiKey?: string` line', () => {
    const authSchemes = dualApiKeySchemes();
    const config = renderTemplate('config.ts', { authSchemes });
    const matches = config.match(/apiKey\?:\s*string/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('node config.ts loadConfig has exactly one `apiKey:` assignment', () => {
    const authSchemes = dualApiKeySchemes();
    const config = renderTemplate('config.ts', { authSchemes });
    // Match `apiKey: process.env.` but NOT `apiKeyQueryName:` (different field).
    const matches = config.match(/^\s+apiKey:\s+process\.env\./gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('node config.ts still carries apiKeyQueryName for the query scheme', () => {
    const authSchemes = dualApiKeySchemes();
    const config = renderTemplate('config.ts', { authSchemes });
    expect(config).toContain('apiKeyQueryName?: string');
    expect(config).toContain('apiKeyQueryName:');
  });

  it('worker config.ts AppConfig has exactly one `apiKey?: string` line', () => {
    const authSchemes = dualApiKeySchemes();
    const config = renderWorkerTemplate('config.ts', { authSchemes });
    const matches = config.match(/apiKey\?:\s*string/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('worker config.ts loadConfig has exactly one `apiKey:` assignment', () => {
    const authSchemes = dualApiKeySchemes();
    const config = renderWorkerTemplate('config.ts', { authSchemes });
    // Worker uses `env.API_KEY` rather than `process.env.API_KEY`.
    const matches = config.match(/^\s+apiKey:\s+env\./gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('worker config.ts still carries apiKeyQueryName for the query scheme', () => {
    const authSchemes = dualApiKeySchemes();
    const config = renderWorkerTemplate('config.ts', { authSchemes });
    expect(config).toContain('apiKeyQueryName?: string');
    expect(config).toContain('apiKeyQueryName:');
  });

  it('end-to-end node emitProject with two apiKey schemes produces a parseable config.ts', async () => {
    const authSchemes = dualApiKeySchemes();
    const tool = buildToolDefinition(makeOp());
    return withTmp(async (dir) => {
      await emitProject(
        {
          serverName: 'dual-key-api',
          serverVersion: '1.0.0',
          baseUrl: 'https://api.example.com',
          transport: 'stdio',
          tools: [tool],
          authSchemes,
          envVars: [
            { name: 'BASE_URL', description: 'base', required: false },
            { name: 'API_KEY', description: 'api key', required: true },
          ],
        },
        { outputDir: dir, force: true, dryRun: false },
      );
      const config = readFileSync(join(dir, 'src/config.ts'), 'utf-8');
      // Structural: exactly one value field and one assignment.
      expect((config.match(/apiKey\?:\s*string/g) ?? []).length).toBe(1);
      expect((config.match(/^\s+apiKey:\s+process\.env\./gm) ?? []).length).toBe(1);
      // Both location metadata fields present.
      expect(config).toContain('apiKeyQueryName?: string');
      // Must parse cleanly (transpileModule catches syntax errors).
      assertParses(config, 'dual-apiKey node config.ts');
    });
  });

  it('end-to-end worker emitWorkerProject with two apiKey schemes produces a parseable config.ts', async () => {
    const authSchemes = dualApiKeySchemes();
    const tool = buildToolDefinition(makeOp());
    return withTmp(async (dir) => {
      await emitWorkerProject(
        {
          serverName: 'dual-key-worker',
          serverVersion: '1.0.0',
          baseUrl: 'https://api.example.com',
          transport: 'http',
          target: 'cloudflare',
          tools: [tool],
          authSchemes,
          envVars: [
            { name: 'BASE_URL', description: 'base', required: false },
            { name: 'API_KEY', description: 'api key', required: true },
          ],
        },
        { outputDir: dir, force: true, dryRun: false },
      );
      const config = readFileSync(join(dir, 'src/config.ts'), 'utf-8');
      expect((config.match(/apiKey\?:\s*string/g) ?? []).length).toBe(1);
      expect((config.match(/^\s+apiKey:\s+env\./gm) ?? []).length).toBe(1);
      expect(config).toContain('apiKeyQueryName?: string');
      assertParses(config, 'dual-apiKey worker config.ts');
    });
  });
});
