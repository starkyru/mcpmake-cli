import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { renderTemplate } from '../../src/emitter/template-loader.js';

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
