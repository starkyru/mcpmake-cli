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
      // A4-H2 made the signature precise: a REQUIRED header (`X-Tenant-Id`) now has
      // NO default (`str`), and an OPTIONAL cookie (`session-id`) is `str | None =
      // None` — replacing the prior all-`str = ""` form so FastMCP marks the
      // required header required and the cookie optional.
      expect(py).toMatch(/X_Tenant_Id: str(?![ |])/); // required: bare `str`, no `= ""`, no `| None`
      expect(py).toMatch(/session_id: str \| None = None/);
      // The upstream request uses the ORIGINAL wire names. A4-H2 also wraps header
      // values in str() (they may now be typed non-str) and gates on `is not None`.
      expect(py).toContain('req_headers["X-Tenant-Id"] = str(X_Tenant_Id)');
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

// ---------------------------------------------------------------------------
// R24-A — two same-location apiKey schemes must not produce duplicate
// per-location interface fields (apiKeyQueryName / apiKeyHeaderName).
// TS2300 is invisible to transpileModule (strips types), so we assert the
// structural invariant: count occurrences of the property strings directly.
// ---------------------------------------------------------------------------
describe('R24-A — per-location apiKey interface dedup (node + worker templates)', () => {
  /** Two query-apiKey schemes — the previous TS2300 trigger. */
  function twoQuerySchemes() {
    const { authSchemes } = detectAuthSchemes({
      TokenA: { type: 'apiKey', in: 'query', name: 'token' },
      TokenB: { type: 'apiKey', in: 'query', name: 'api_key' },
    });
    return authSchemes;
  }

  /** A header + query pair — should produce one of each field, no dup. */
  function headerPlusQuerySchemes() {
    const { authSchemes } = detectAuthSchemes({
      HeaderKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
    });
    return authSchemes;
  }

  /** Single query scheme — the common case must be unaffected. */
  function singleQueryScheme() {
    const { authSchemes } = detectAuthSchemes({
      QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
    });
    return authSchemes;
  }

  // --- node template ---

  it('node: two in:query schemes → exactly one apiKeyQueryName?: string', () => {
    const config = renderTemplate('config.ts', { authSchemes: twoQuerySchemes() });
    const matches = config.match(/apiKeyQueryName\?:\s*string/g) ?? [];
    expect(matches).toHaveLength(1);
    assertParses(config, 'node two-query config.ts');
  });

  it('node: two in:query schemes → exactly one apiKeyQueryName: assignment', () => {
    const config = renderTemplate('config.ts', { authSchemes: twoQuerySchemes() });
    const matches = config.match(/^\s+apiKeyQueryName:/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('node: header+query pair → one apiKeyQueryName?: string (no header dup)', () => {
    const config = renderTemplate('config.ts', { authSchemes: headerPlusQuerySchemes() });
    const ifaceMatches = config.match(/apiKeyQueryName\?:\s*string/g) ?? [];
    expect(ifaceMatches).toHaveLength(1);
    // apiKey value emitted once (already guarded by R23-C).
    expect((config.match(/apiKey\?:\s*string/g) ?? []).length).toBe(1);
    assertParses(config, 'node header+query config.ts');
  });

  it('node: single in:query scheme → apiKeyQueryName?: string still present (flag absent = emit)', () => {
    const config = renderTemplate('config.ts', { authSchemes: singleQueryScheme() });
    expect(config).toContain('apiKeyQueryName?: string');
    expect(config).toContain('apiKeyQueryName:');
    assertParses(config, 'node single-query config.ts');
  });

  // --- worker template ---

  it('worker: two in:query schemes → exactly one apiKeyQueryName?: string', () => {
    const config = renderWorkerTemplate('config.ts', { authSchemes: twoQuerySchemes() });
    const matches = config.match(/apiKeyQueryName\?:\s*string/g) ?? [];
    expect(matches).toHaveLength(1);
    assertParses(config, 'worker two-query config.ts');
  });

  it('worker: two in:query schemes → exactly one apiKeyQueryName: assignment', () => {
    const config = renderWorkerTemplate('config.ts', { authSchemes: twoQuerySchemes() });
    const matches = config.match(/^\s+apiKeyQueryName:/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('worker: header+query pair → one apiKeyQueryName?: string (no header dup)', () => {
    const config = renderWorkerTemplate('config.ts', { authSchemes: headerPlusQuerySchemes() });
    const ifaceMatches = config.match(/apiKeyQueryName\?:\s*string/g) ?? [];
    expect(ifaceMatches).toHaveLength(1);
    expect((config.match(/apiKey\?:\s*string/g) ?? []).length).toBe(1);
    assertParses(config, 'worker header+query config.ts');
  });

  it('worker: single in:query scheme → apiKeyQueryName?: string still present (flag absent = emit)', () => {
    const config = renderWorkerTemplate('config.ts', { authSchemes: singleQueryScheme() });
    expect(config).toContain('apiKeyQueryName?: string');
    expect(config).toContain('apiKeyQueryName:');
    assertParses(config, 'worker single-query config.ts');
  });

  // --- end-to-end with emitProject/emitWorkerProject ---

  it('end-to-end node: two in:query schemes → parseable config.ts with exactly one apiKeyQueryName', async () => {
    const authSchemes = twoQuerySchemes();
    const tool = buildToolDefinition(makeOp());
    return withTmp(async (dir) => {
      await emitProject(
        {
          serverName: 'two-query-node',
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
      expect((config.match(/apiKeyQueryName\?:\s*string/g) ?? []).length).toBe(1);
      expect((config.match(/^\s+apiKeyQueryName:/gm) ?? []).length).toBe(1);
      assertParses(config, 'e2e node two-query config.ts');
    });
  });

  it('end-to-end worker: two in:query schemes → parseable config.ts with exactly one apiKeyQueryName', async () => {
    const authSchemes = twoQuerySchemes();
    const tool = buildToolDefinition(makeOp());
    return withTmp(async (dir) => {
      await emitWorkerProject(
        {
          serverName: 'two-query-worker',
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
      expect((config.match(/apiKeyQueryName\?:\s*string/g) ?? []).length).toBe(1);
      expect((config.match(/^\s+apiKeyQueryName:/gm) ?? []).length).toBe(1);
      assertParses(config, 'e2e worker two-query config.ts');
    });
  });
});

// ---------------------------------------------------------------------------
// R25 — duplicate http-bearer / http-basic / oauth2 schemes must not produce
// duplicate interface properties (TS2300) or duplicate function declarations
// (TS2393) in the generated config.ts.
// transpileModule strips types so TS2300 is invisible; we assert the structural
// invariant by counting occurrences of the property/function strings directly.
// ---------------------------------------------------------------------------
describe('R25 — non-apiKey scheme dedup (http-bearer / http-basic / oauth2)', () => {
  /** Two http-bearer schemes — the previous TS2300 trigger for bearerToken?. */
  function twoBearerSchemes() {
    const { authSchemes } = detectAuthSchemes({
      BearerA: { type: 'http', scheme: 'bearer' },
      BearerB: { type: 'http', scheme: 'bearer' },
    });
    return authSchemes;
  }

  /** Two http-basic schemes. */
  function twoBasicSchemes() {
    const { authSchemes } = detectAuthSchemes({
      BasicA: { type: 'http', scheme: 'basic' },
      BasicB: { type: 'http', scheme: 'basic' },
    });
    return authSchemes;
  }

  /** Two oauth2 schemes (common: per-app + per-user OAuth, e.g. Stripe/GitHub). */
  function twoOAuth2Schemes() {
    const { authSchemes } = detectAuthSchemes({
      OAuth2App: {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://api.example.com/token',
            scopes: { read: 'Read access' },
          },
        },
      },
      OAuth2User: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://api.example.com/auth',
            tokenUrl: 'https://api.example.com/token',
            scopes: { write: 'Write access' },
          },
        },
      },
    });
    return authSchemes;
  }

  /** Single bearer — backward compat: field must still be present. */
  function singleBearerScheme() {
    const { authSchemes } = detectAuthSchemes({
      BearerOnly: { type: 'http', scheme: 'bearer' },
    });
    return authSchemes;
  }

  /** Single basic — backward compat. */
  function singleBasicScheme() {
    const { authSchemes } = detectAuthSchemes({
      BasicOnly: { type: 'http', scheme: 'basic' },
    });
    return authSchemes;
  }

  /** Single oauth2 — backward compat. */
  function singleOAuth2Scheme() {
    const { authSchemes } = detectAuthSchemes({
      OAuth2Only: {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: 'https://api.example.com/token', scopes: {} } },
      },
    });
    return authSchemes;
  }

  /** Mixed spec: one apiKey + one bearer + one oauth2 — all fields present once. */
  function mixedSchemes() {
    const { authSchemes } = detectAuthSchemes({
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      Bearer: { type: 'http', scheme: 'bearer' },
      OAuth2: {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: 'https://api.example.com/token', scopes: {} } },
      },
    });
    return authSchemes;
  }

  // --- http-bearer: node ---

  it('node: two http-bearer schemes → exactly one bearerToken?: string', () => {
    const config = renderTemplate('config.ts', { authSchemes: twoBearerSchemes() });
    const matches = config.match(/bearerToken\?:\s*string/g) ?? [];
    expect(matches).toHaveLength(1);
    assertParses(config, 'node two-bearer config.ts');
  });

  it('node: single http-bearer → bearerToken?: string still present (backward compat)', () => {
    const config = renderTemplate('config.ts', { authSchemes: singleBearerScheme() });
    expect(config).toContain('bearerToken?: string');
    assertParses(config, 'node single-bearer config.ts');
  });

  // --- http-bearer: worker ---

  it('worker: two http-bearer schemes → exactly one bearerToken?: string', () => {
    const config = renderWorkerTemplate('config.ts', { authSchemes: twoBearerSchemes() });
    const matches = config.match(/bearerToken\?:\s*string/g) ?? [];
    expect(matches).toHaveLength(1);
    assertParses(config, 'worker two-bearer config.ts');
  });

  it('worker: single http-bearer → bearerToken?: string still present (backward compat)', () => {
    const config = renderWorkerTemplate('config.ts', { authSchemes: singleBearerScheme() });
    expect(config).toContain('bearerToken?: string');
    assertParses(config, 'worker single-bearer config.ts');
  });

  // --- http-basic: node ---

  it('node: two http-basic schemes → exactly one basicUsername?: string', () => {
    const config = renderTemplate('config.ts', { authSchemes: twoBasicSchemes() });
    const matches = config.match(/basicUsername\?:\s*string/g) ?? [];
    expect(matches).toHaveLength(1);
    assertParses(config, 'node two-basic config.ts');
  });

  it('node: single http-basic → basicUsername?: string + basicPassword?: string still present (backward compat)', () => {
    const config = renderTemplate('config.ts', { authSchemes: singleBasicScheme() });
    expect(config).toContain('basicUsername?: string');
    expect(config).toContain('basicPassword?: string');
    assertParses(config, 'node single-basic config.ts');
  });

  // --- http-basic: worker ---

  it('worker: two http-basic schemes → exactly one basicUsername?: string', () => {
    const config = renderWorkerTemplate('config.ts', { authSchemes: twoBasicSchemes() });
    const matches = config.match(/basicUsername\?:\s*string/g) ?? [];
    expect(matches).toHaveLength(1);
    assertParses(config, 'worker two-basic config.ts');
  });

  it('worker: single http-basic → basicUsername?: string + basicPassword?: string still present (backward compat)', () => {
    const config = renderWorkerTemplate('config.ts', { authSchemes: singleBasicScheme() });
    expect(config).toContain('basicUsername?: string');
    expect(config).toContain('basicPassword?: string');
    assertParses(config, 'worker single-basic config.ts');
  });

  // --- oauth2: node only (worker template has no oauth2 block) ---

  it('node: two oauth2 schemes → exactly one oauth2Token?: string', () => {
    const config = renderTemplate('config.ts', { authSchemes: twoOAuth2Schemes() });
    const matches = config.match(/oauth2Token\?:\s*string/g) ?? [];
    expect(matches).toHaveLength(1);
    assertParses(config, 'node two-oauth2 config.ts');
  });

  it('node: two oauth2 schemes → exactly one resolveOAuthScopes function', () => {
    const config = renderTemplate('config.ts', { authSchemes: twoOAuth2Schemes() });
    const matches = config.match(/function resolveOAuthScopes\(\)/g) ?? [];
    expect(matches).toHaveLength(1);
    assertParses(config, 'node two-oauth2 config.ts (fn dedup)');
  });

  it('node: single oauth2 → all oauth2 fields present (backward compat)', () => {
    const config = renderTemplate('config.ts', { authSchemes: singleOAuth2Scheme() });
    expect(config).toContain('oauth2Token?: string');
    expect(config).toContain('oauth2ClientId?: string');
    expect(config).toContain('oauth2ClientSecret?: string');
    expect(config).toContain('oauth2Scopes: string[]');
    expect(config).toContain('function resolveOAuthScopes()');
    assertParses(config, 'node single-oauth2 config.ts');
  });

  // --- mixed spec: apiKey + bearer + oauth2 (one each) ---

  it('node: mixed (apiKey + bearer + oauth2) → all fields present exactly once', () => {
    const config = renderTemplate('config.ts', { authSchemes: mixedSchemes() });
    expect((config.match(/apiKey\?:\s*string/g) ?? []).length).toBe(1);
    expect((config.match(/bearerToken\?:\s*string/g) ?? []).length).toBe(1);
    expect((config.match(/oauth2Token\?:\s*string/g) ?? []).length).toBe(1);
    expect((config.match(/function resolveOAuthScopes\(\)/g) ?? []).length).toBe(1);
    assertParses(config, 'node mixed-auth config.ts');
  });

  it('worker: mixed (apiKey + bearer) → all fields present exactly once', () => {
    const { authSchemes } = detectAuthSchemes({
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      Bearer: { type: 'http', scheme: 'bearer' },
    });
    const config = renderWorkerTemplate('config.ts', { authSchemes });
    expect((config.match(/apiKey\?:\s*string/g) ?? []).length).toBe(1);
    expect((config.match(/bearerToken\?:\s*string/g) ?? []).length).toBe(1);
    assertParses(config, 'worker mixed-auth config.ts');
  });
});
