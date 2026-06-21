import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { renderTemplate } from '../../src/emitter/template-loader.js';
import { renderWorkerTemplate } from '../../src/emitter/worker-template-loader.js';

/** Transpile rendered TS and fail on any syntactic diagnostic (proves it parses). */
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

const OAUTH_SCHEME = {
  type: 'oauth2' as const,
  envVarName: 'OAUTH2_CLIENT_ID',
  schemeName: 'OAuth2',
  scopes: ['read', 'write'],
};

function httpServer(over: Record<string, unknown> = {}): string {
  return renderTemplate('server-main-http.ts', {
    serverName: 'oauth-api',
    serverVersion: '1.0.0',
    tools: [{ name: 'a' }],
    hasResources: false,
    hasPrompts: false,
    hasOAuth: true,
    hasAsyncTools: false,
    authSchemes: [OAUTH_SCHEME],
    ...over,
  });
}

describe('L-authoff — node HTTP server fails closed by default', () => {
  const src = httpServer();

  it('renders parseable TypeScript', () => {
    assertParses(src, 'server-main-http');
  });

  it('isAuthorized denies (does NOT return true) when MCP_AUTH_TOKEN is unset', () => {
    // The old open-by-default `return true` for the unset-token case is gone.
    expect(src).not.toContain('if (!expected) return true');
    // Instead it returns the explicit opt-in flag (fail closed unless opted in).
    expect(src).toContain('if (!expected) return ALLOW_UNAUTHENTICATED;');
  });

  it('the escape hatch uses the exact MCP_ALLOW_UNAUTHENTICATED env name', () => {
    expect(src).toContain(
      "const ALLOW_UNAUTHENTICATED = process.env.MCP_ALLOW_UNAUTHENTICATED === 'true'",
    );
  });

  it('warns at startup when running unauthenticated', () => {
    expect(src).toContain('console.error');
    expect(src).toContain('running UNAUTHENTICATED');
    // And a distinct message for the fail-closed (denying) case.
    expect(src).toMatch(/authenticated routes will return 401/);
  });

  it('keeps /health and /ready open (public paths) regardless of auth', () => {
    expect(src).toContain("url.pathname === '/health'");
    expect(src).toContain("url.pathname === '/ready'");
  });
});

describe('L-oauth — dead Authorization-Code + PKCE scaffolding removed', () => {
  const oauth = renderTemplate('oauth.ts', { authSchemes: [OAUTH_SCHEME] });

  it('renders parseable TypeScript', () => {
    assertParses(oauth, 'oauth.ts');
  });

  it('no longer exports the unusable interactive-flow helpers', () => {
    expect(oauth).not.toContain('generatePkce');
    expect(oauth).not.toContain('buildAuthorizationUrl');
    expect(oauth).not.toContain('exchangeCode');
  });

  it('keeps the working non-interactive grants', () => {
    expect(oauth).toContain('clientCredentialsGrant');
    expect(oauth).toContain('refreshToken');
    expect(oauth).toContain('process.env.OAUTH2_TOKEN');
  });

  it('metadata advertises only the grants that actually work', () => {
    expect(oauth).toContain("grant_types_supported: ['client_credentials', 'refresh_token']");
    // The interactive code flow is no longer advertised.
    expect(oauth).not.toContain("response_types_supported: ['code']");
    expect(oauth).not.toContain('authorization_code');
    expect(oauth).not.toContain('authorization_endpoint');
    expect(oauth).not.toContain('code_challenge_methods_supported');
  });

  it('documents that the interactive flow is unsupported', () => {
    expect(oauth).toMatch(/not supported|unsupported|NOT supported/i);
    expect(oauth).toContain('/callback');
  });
});

describe('L-scopes — OAuth scopes are threaded, not hardcoded empty', () => {
  it('config exposes resolveOAuthScopes with the OAUTH2_SCOPES env override', () => {
    const config = renderTemplate('config.ts', { authSchemes: [OAUTH_SCHEME] });
    assertParses(config, 'config.ts');
    expect(config).toContain('function resolveOAuthScopes');
    expect(config).toContain('process.env.OAUTH2_SCOPES');
    // Spec scopes are baked as the default when present on the scheme.
    expect(config).toContain('return ["read","write"];');
    expect(config).toContain('oauth2Scopes: resolveOAuthScopes()');
  });

  it('defaults to an empty array (valid TS) when the scheme carries no scopes', () => {
    const config = renderTemplate('config.ts', {
      authSchemes: [{ type: 'oauth2', envVarName: 'OAUTH2_CLIENT_ID', schemeName: 'OAuth2' }],
    });
    assertParses(config, 'config.ts (no scopes)');
    expect(config).toContain('return [];');
  });

  it('non-OAuth config is unaffected (no resolveOAuthScopes emitted)', () => {
    const config = renderTemplate('config.ts', {
      authSchemes: [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN', schemeName: 'b' }],
    });
    expect(config).not.toContain('resolveOAuthScopes');
    expect(config).not.toContain('oauth2Scopes');
  });

  it('auth-provider passes config.oauth2Scopes into getAccessToken (not [])', () => {
    const auth = renderTemplate('auth-provider.ts', {
      authSchemes: [OAUTH_SCHEME],
      hasOAuth: true,
    });
    assertParses(auth, 'auth-provider.ts');
    expect(auth).toContain('scopes: config.oauth2Scopes');
    expect(auth).not.toContain('scopes: [],');
  });

  it('the OAuth metadata endpoint advertises config.oauth2Scopes', () => {
    const src = httpServer();
    expect(src).toContain('scopes: config.oauth2Scopes');
    expect(src).not.toContain('scopes: [],');
  });
});

describe('R4-G — OAuth issuer is not derived from a spoofable Host header', () => {
  const src = httpServer();

  it('renders parseable TypeScript after the fix', () => {
    assertParses(src, 'server-main-http (R4-G)');
  });

  it('no longer unconditionally reflects the Host into the issuer', () => {
    // The old one-liner reflected req.headers.host verbatim with no allowlist /
    // public-URL branch in front of it.
    expect(src).not.toContain(
      "const issuer = allowedOrigin ?? `${proto}://${req.headers.host ?? 'localhost'}`;",
    );
  });

  it('reads the new MCP_PUBLIC_URL and MCP_ALLOWED_HOSTS env vars', () => {
    expect(src).toContain('process.env.MCP_PUBLIC_URL');
    expect(src).toContain('process.env.MCP_ALLOWED_HOSTS');
  });

  it('validates MCP_PUBLIC_URL is an absolute http(s) URL and uses its origin', () => {
    // Parsed via URL and restricted to http/https before being trusted.
    expect(src).toContain("u.protocol !== 'http:' && u.protocol !== 'https:'");
    expect(src).toContain('return u.origin;');
  });

  it('resolves the issuer with ALLOWED_ORIGIN → MCP_PUBLIC_URL precedence', () => {
    // ALLOWED_ORIGIN still wins, then the configured public origin.
    const allowedIdx = src.indexOf('if (allowedOrigin) {\n          issuer = allowedOrigin;');
    const publicIdx = src.indexOf(
      '} else if (mcpPublicOrigin) {\n          issuer = mcpPublicOrigin;',
    );
    expect(allowedIdx).toBeGreaterThan(-1);
    expect(publicIdx).toBeGreaterThan(allowedIdx);
  });

  it('rejects a Host outside MCP_ALLOWED_HOSTS with a 400 (logged), not a reflected issuer', () => {
    expect(src).toContain('} else if (allowedHosts.size > 0) {');
    // The check rejects unless the full Host OR its hostname-without-port is allowed.
    expect(src).toContain(
      '!allowedHosts.has(host) && !(hostNoPort && allowedHosts.has(hostNoPort))',
    );
    expect(src).toContain(
      "sendJson(res, 400, { error: 'Invalid Host header for OAuth metadata' });",
    );
    expect(src).toContain(
      "log('error', 'Invalid Host header for OAuth metadata', { host: rawHost });",
    );
    // The 400 path must short-circuit before sending metadata.
    const invalidHostIdx = src.indexOf('Invalid Host header for OAuth metadata');
    const metadataIdx = src.indexOf('getAuthServerMetadata(');
    expect(invalidHostIdx).toBeGreaterThan(-1);
    expect(invalidHostIdx).toBeLessThan(metadataIdx);
  });

  it('normalizes the Host port so a bare-hostname allowlist matches `host:port` (R4-G follow-up)', () => {
    // The Host is parsed once: `hostname` (no port/userinfo) drives the allowlist
    // so an operator listing `example.com` accepts `Host: example.com:3000`.
    expect(src).toContain('new URL(`http://${rawHost}`)');
    expect(src).toContain('const hostNoPort = parsedHost?.hostname ?? host;');
  });

  it('builds the issuer from the parsed host:port, never the raw Host (no userinfo injection)', () => {
    // `Host: evil@example.com` would pass a bare-hostname allowlist via hostname,
    // but the issuer must be derived from the parsed host (userinfo stripped),
    // not the raw header — otherwise the issuer becomes `http://evil@example.com`.
    expect(src).toContain('issuer = `${proto}://${parsedHost?.hostPort ?? rawHost}`;');
    expect(src).not.toContain('issuer = `${proto}://${rawHost}`;');
  });

  it('warns once when no allowlist/public-URL pins the issuer (dev fallback)', () => {
    expect(src).toContain('let warnedHostDerivedIssuer = false;');
    expect(src).toContain('if (!warnedHostDerivedIssuer) {');
    expect(src).toContain('warnedHostDerivedIssuer = true;');
    expect(src).toMatch(/OAuth issuer derived from the Host header/);
  });

  it('does not emit the OAuth issuer plumbing when hasOAuth is false', () => {
    const noOauth = httpServer({ hasOAuth: false, authSchemes: [] });
    assertParses(noOauth, 'server-main-http (no OAuth)');
    expect(noOauth).not.toContain('mcpPublicOrigin');
    expect(noOauth).not.toContain('MCP_ALLOWED_HOSTS');
    expect(noOauth).not.toContain('warnedHostDerivedIssuer');
  });
});

describe('L-catch — OAuth failures are observable, never silently swallowed', () => {
  it('oauth.ts refresh failure is logged (without exposing the token)', () => {
    const oauth = renderTemplate('oauth.ts', { authSchemes: [OAUTH_SCHEME] });
    expect(oauth).not.toContain('} catch {');
    expect(oauth).toContain('OAuth token refresh failed');
    expect(oauth).toContain('console.error');
  });

  it('auth-provider token-fetch fallback is logged (without exposing the token)', () => {
    const auth = renderTemplate('auth-provider.ts', {
      authSchemes: [OAUTH_SCHEME],
      hasOAuth: true,
    });
    expect(auth).toContain('console.error');
    expect(auth).toContain('OAuth token fetch failed');
    // The fallback behavior itself is preserved.
    expect(auth).toContain("headers['Authorization'] = `Bearer ${config.oauth2Token}`");
  });
});

describe('R4-F — OAuth error message omits raw response body', () => {
  const oauth = renderTemplate('oauth.ts', { authSchemes: [OAUTH_SCHEME] });

  it('renders parseable TypeScript after the fix', () => {
    assertParses(oauth, 'oauth.ts (R4-F)');
  });

  it('client-credentials error does not include the raw upstream body', () => {
    // The old pattern read response.text() and interpolated it into the thrown message.
    expect(oauth).not.toMatch(/response\.text\(\)[^;]*client credentials/);
    expect(oauth).not.toMatch(/client credentials failed.*\$\{body\}/);
  });

  it('client-credentials error still surfaces the HTTP status code', () => {
    expect(oauth).toContain('OAuth client credentials failed');
    expect(oauth).toContain('response.status');
  });
});

describe('R4-D — SSE connection set has a capacity cap', () => {
  const sse = renderTemplate('task-sse.ts', {});

  it('renders parseable TypeScript', () => {
    assertParses(sse, 'task-sse.ts (R4-D)');
  });

  it('reads MCP_MAX_SSE_CONNECTIONS before adding a connection', () => {
    expect(sse).toContain('MCP_MAX_SSE_CONNECTIONS');
    // Cap check must precede connections.add.
    const capIdx = sse.indexOf('MCP_MAX_SSE_CONNECTIONS');
    const addIdx = sse.indexOf('connections.add(conn)');
    expect(capIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeLessThan(addIdx);
  });

  it('responds 503 when the cap is reached instead of adding the connection', () => {
    expect(sse).toMatch(/connections\.size >= max/);
    expect(sse).toContain('503');
    expect(sse).toContain('SSE connection limit reached');
  });

  it('broadcast deletes dead connections instead of skipping them', () => {
    // The old pattern was: if (conn.res.writableEnded) continue;
    // The fixed pattern must delete before continuing.
    expect(sse).toContain('connections.delete(conn)');
    // Deletion must appear in the broadcast function (before listTasks usage).
    const broadcastBlock = sse.slice(
      sse.indexOf('function broadcast('),
      sse.indexOf('taskEvents.on('),
    );
    expect(broadcastBlock).toContain('connections.delete(conn)');
    expect(broadcastBlock).not.toMatch(/writableEnded\) continue;/);
  });

  it('R5-A: rejects negative MCP_MAX_SSE_CONNECTIONS and falls back to 500', () => {
    // The old `|| 500` guard fires only for falsy values; -1 is truthy and slips through.
    // The fixed guard must use Number.isInteger + rawMax > 0 so negatives are caught.
    expect(sse).toContain('Number.isInteger(rawMax) && rawMax > 0');
    // The literal fallback 500 must still be present.
    expect(sse).toContain(': 500');
    // The old unguarded form must NOT appear.
    expect(sse).not.toMatch(
      /parseInt\(process\.env\.MCP_MAX_SSE_CONNECTIONS[^,]*,\s*10\)\s*\|\|\s*500/,
    );
  });
});

describe('R5-D — task-manager evicts a terminal task before the oldest working task', () => {
  const mgr = renderTemplate('task-manager.ts', {});

  it('renders parseable TypeScript', () => {
    assertParses(mgr, 'task-manager.ts (R5-D)');
  });

  it('prefers evicting a terminal task (completed/failed/cancelled) over the oldest entry', () => {
    // Must use .find() to locate a terminal entry first.
    expect(mgr).toContain(
      "t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'",
    );
    // Nullish-coalesce to oldest is the fallback, not the primary path.
    const evictBlock = mgr.slice(
      mgr.indexOf('tasks.size >= MAX_TASKS'),
      mgr.indexOf('const task: Task ='),
    );
    expect(evictBlock).toContain('terminalKey');
    // The terminal search must appear before the fallback to oldest.
    const terminalIdx = evictBlock.indexOf('.find(');
    const fallbackIdx = evictBlock.indexOf('tasks.keys().next().value');
    expect(terminalIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(terminalIdx);
  });

  it('still deletes the oldest entry when no terminal task exists (fallback preserved)', () => {
    // The fallback via ?? tasks.keys().next().value must remain.
    expect(mgr).toContain('tasks.keys().next().value');
    // Guard: only delete if the key is not undefined.
    expect(mgr).toContain('terminalKey !== undefined');
  });
});

describe('R7-C — node config.ts uses posInt guard for numeric env vars', () => {
  const config = renderTemplate('config.ts', {
    authSchemes: [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN', schemeName: 'b' }],
  });

  it('renders parseable TypeScript', () => {
    assertParses(config, 'config.ts (R7-C)');
  });

  it('declares posInt helper with positive-integer predicate', () => {
    expect(config).toContain('const posInt = (v: string | undefined, d: number): number =>');
    expect(config).toContain('Number.isInteger(n) && n > 0 ? n : d');
  });

  it('uses nonNegInt for MAX_RETRIES and REQUEST_INTERVAL_MS', () => {
    expect(config).toContain('maxRetries: nonNegInt(process.env.MAX_RETRIES, 3)');
    expect(config).toContain('requestIntervalMs: nonNegInt(process.env.REQUEST_INTERVAL_MS, 100)');
  });

  it('no longer uses bare parseInt for MAX_RETRIES or REQUEST_INTERVAL_MS', () => {
    expect(config).not.toContain('parseInt(process.env.MAX_RETRIES');
    expect(config).not.toContain('parseInt(process.env.REQUEST_INTERVAL_MS');
  });
});

describe('R7-C — worker config.ts uses posInt guard for numeric env vars', () => {
  const config = renderWorkerTemplate('config.ts', {
    authSchemes: [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN', schemeName: 'b' }],
  });

  it('renders parseable TypeScript', () => {
    assertParses(config, 'worker config.ts (R7-C)');
  });

  it('declares posInt helper with positive-integer predicate', () => {
    expect(config).toContain('const posInt = (v: string | undefined, d: number): number =>');
    expect(config).toContain('Number.isInteger(n) && n > 0 ? n : d');
  });

  it('uses nonNegInt for MAX_RETRIES and REQUEST_INTERVAL_MS (reads from env binding)', () => {
    expect(config).toContain('maxRetries: nonNegInt(env.MAX_RETRIES, 3)');
    expect(config).toContain('requestIntervalMs: nonNegInt(env.REQUEST_INTERVAL_MS, 100)');
  });

  it('no longer uses bare parseInt for MAX_RETRIES or REQUEST_INTERVAL_MS', () => {
    expect(config).not.toContain('parseInt(env.MAX_RETRIES');
    expect(config).not.toContain('parseInt(env.REQUEST_INTERVAL_MS');
  });
});

// ---------------------------------------------------------------------------
// A4-M3 — nonNegInt honours zero; negative / NaN still fall back
// ---------------------------------------------------------------------------

describe('A4-M3 — node config.ts: nonNegInt honours zero for MAX_RETRIES and REQUEST_INTERVAL_MS', () => {
  const config = renderTemplate('config.ts', {
    authSchemes: [],
  });

  it('renders parseable TypeScript', () => {
    assertParses(config, 'config.ts (A4-M3)');
  });

  it('declares nonNegInt helper with non-negative predicate (n >= 0)', () => {
    expect(config).toContain('const nonNegInt = (v: string | undefined, d: number): number =>');
    expect(config).toContain('Number.isInteger(n) && n >= 0 ? n : d');
  });

  it('uses nonNegInt (not posInt) for MAX_RETRIES', () => {
    expect(config).toContain('maxRetries: nonNegInt(process.env.MAX_RETRIES, 3)');
    expect(config).not.toContain('maxRetries: posInt(process.env.MAX_RETRIES');
  });

  it('uses nonNegInt (not posInt) for REQUEST_INTERVAL_MS', () => {
    expect(config).toContain('requestIntervalMs: nonNegInt(process.env.REQUEST_INTERVAL_MS, 100)');
    expect(config).not.toContain('requestIntervalMs: posInt(process.env.REQUEST_INTERVAL_MS');
  });
});

describe('A4-M3 — worker config.ts: nonNegInt honours zero for MAX_RETRIES and REQUEST_INTERVAL_MS', () => {
  const config = renderWorkerTemplate('config.ts', {
    authSchemes: [],
  });

  it('renders parseable TypeScript', () => {
    assertParses(config, 'worker config.ts (A4-M3)');
  });

  it('declares nonNegInt helper with non-negative predicate (n >= 0)', () => {
    expect(config).toContain('const nonNegInt = (v: string | undefined, d: number): number =>');
    expect(config).toContain('Number.isInteger(n) && n >= 0 ? n : d');
  });

  it('uses nonNegInt (not posInt) for MAX_RETRIES', () => {
    expect(config).toContain('maxRetries: nonNegInt(env.MAX_RETRIES, 3)');
    expect(config).not.toContain('maxRetries: posInt(env.MAX_RETRIES');
  });

  it('uses nonNegInt (not posInt) for REQUEST_INTERVAL_MS', () => {
    expect(config).toContain('requestIntervalMs: nonNegInt(env.REQUEST_INTERVAL_MS, 100)');
    expect(config).not.toContain('requestIntervalMs: posInt(env.REQUEST_INTERVAL_MS');
  });
});
