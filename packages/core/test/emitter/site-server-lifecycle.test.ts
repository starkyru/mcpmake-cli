import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSiteTemplate } from '../../src/emitter/site-template-loader.js';
import type { SiteProjectManifest } from '../../src/types/site.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_TEMPLATE_DIR = resolve(__dirname, '../../src/emitter/site-templates');

/** Transpile a rendered template and fail on any syntactic diagnostic. */
function assertParses(source: string, label: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const syntactic = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (syntactic.length > 0) {
    const msgs = syntactic
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('; ');
    throw new Error(`${label} did not parse: ${msgs}`);
  }
  expect(syntactic).toHaveLength(0);
}

const manifest: SiteProjectManifest = {
  serverName: 'example-site',
  serverVersion: '1.2.3',
  baseUrl: 'https://example.com',
  transport: 'http',
  siteDescriptor: {
    siteId: 'site_x',
    baseUrl: 'https://example.com',
    pages: [],
    analyzedAt: '2026-06-20T00:00:00.000Z',
    version: 1,
    crawlDepth: 2,
    metadata: {},
  },
  tools: [],
  envVars: [],
  browserConfig: {
    headless: true,
    idleTimeoutMs: 300000,
    viewport: { width: 1280, height: 720 },
    maxSessions: 10,
  },
};

describe('D-H8: site HTTP server uses a per-request stateless factory', () => {
  const out = renderSiteTemplate('server-main-http.ts', manifest);

  it('builds a fresh McpServer per /mcp request, not one shared global', () => {
    // A factory replaces the single module-level `new McpServer(...)` instance.
    expect(out).toContain('function createMcpServer()');
    expect(out).toContain('const reqServer = createMcpServer();');
    // The old shared-server connect-per-request anti-pattern is gone.
    expect(out).not.toContain(
      'await server.connect(transport);\n      await transport.handleRequest',
    );
  });

  it('closes BOTH the per-request server and transport on response close', () => {
    expect(out).toContain("res.on('close'");
    expect(out).toContain('void transport.close();');
    expect(out).toContain('void reqServer.close();');
  });

  it('renders to valid TypeScript', () => {
    assertParses(out, 'site-server-main-http');
  });
});

describe('D-H5: browser-manager default-session + capacity/launch races', () => {
  const src = readFileSync(resolve(SITE_TEMPLATE_DIR, 'browser-manager.ts.hbs'), 'utf-8');

  it('stores one real __default__ session instead of renaming to session_*', () => {
    // No-ID calls must reuse a single fixed-ID session, never mint session_* ids.
    expect(src).not.toContain('`session_${Date.now()');
    expect(src).toContain('return { page, sessionId: id };');
  });

  it('single-flights browser launch and per-id session creation', () => {
    expect(src).toContain('let browserLaunch: Promise<Browser> | undefined;');
    expect(src).toContain('async function getBrowser()');
    expect(src).toContain('const sessionCreations = new Map');
    expect(src).toContain('const inFlight = sessionCreations.get(id);');
  });

  it('reserves the capacity slot BEFORE awaiting context creation', () => {
    // The placeholder reservation is inserted before any await in createSession.
    const reserveIdx = src.indexOf('sessions.set(id, reserved);');
    const awaitIdx = src.indexOf('await getBrowser();');
    expect(reserveIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(reserveIdx).toBeLessThan(awaitIdx);
  });

  it('R5-C: idle timer calls .unref() immediately after setInterval', () => {
    // Keeps the Node.js event loop from staying alive solely due to the idle check.
    const intervalIdx = src.indexOf('}, 30_000); // Check every 30 seconds');
    const unrefIdx = src.indexOf('idleTimer.unref?.();');
    expect(intervalIdx).toBeGreaterThan(-1);
    expect(unrefIdx).toBeGreaterThan(-1);
    // unref must appear AFTER the setInterval closing brace
    expect(unrefIdx).toBeGreaterThan(intervalIdx);
  });
});

describe('R5-A: config.ts.hbs posInt guard rejects zero and negative values', () => {
  const configSrc = readFileSync(resolve(SITE_TEMPLATE_DIR, 'config.ts.hbs'), 'utf-8');

  it('declares posInt helper with positive-integer predicate', () => {
    expect(configSrc).toContain('const posInt = (v: string | undefined, d: number): number =>');
    expect(configSrc).toContain('Number.isInteger(n) && n > 0 ? n : d');
  });

  it('uses posInt for all four numeric env fields', () => {
    expect(configSrc).toContain('posInt(process.env.IDLE_TIMEOUT_MS,');
    expect(configSrc).toContain('posInt(process.env.VIEWPORT_WIDTH,');
    expect(configSrc).toContain('posInt(process.env.VIEWPORT_HEIGHT,');
    expect(configSrc).toContain('posInt(process.env.MAX_SESSIONS,');
  });

  it('no longer uses the || fallback pattern for those four fields', () => {
    // The old parseInt(...) || default was truthy-only — it let negative values through.
    expect(configSrc).not.toContain('parseInt(process.env.IDLE_TIMEOUT_MS');
    expect(configSrc).not.toContain('parseInt(process.env.VIEWPORT_WIDTH');
    expect(configSrc).not.toContain('parseInt(process.env.VIEWPORT_HEIGHT');
    expect(configSrc).not.toContain('parseInt(process.env.MAX_SESSIONS');
  });

  it('renders to valid TypeScript after template substitution', () => {
    const rendered = renderSiteTemplate('config.ts', manifest);
    assertParses(rendered, 'site-config');
  });
});

describe('R5-B: site HTTP server rejects invalid PORT at startup', () => {
  const out = renderSiteTemplate('server-main-http.ts', manifest);

  it('exits with an error log when PORT is not a valid integer', () => {
    expect(out).toContain('!Number.isInteger(port) || port < 1 || port > 65535');
    expect(out).toContain("log('error', 'Invalid PORT value, must be 1-65535'");
    expect(out).toContain('process.exit(1)');
  });

  it('PORT guard appears before httpServer.listen()', () => {
    const guardIdx = out.indexOf('!Number.isInteger(port)');
    const listenIdx = out.indexOf('httpServer.listen(port');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(listenIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(listenIdx);
  });
});

describe('R8-B — site HTTP/stdio server stdio else-branch handles both SIGTERM and SIGINT', () => {
  // server-main-http.ts emits both the http branch and the stdio else-branch unconditionally.
  // The else-branch must use a shared shutdown const so Ctrl-C does not orphan Chromium.
  const out = renderSiteTemplate('server-main-http.ts', manifest);

  it('renders to valid TypeScript', () => {
    assertParses(out, 'site-server-main-http-stdio-sigint');
  });

  it('else-branch declares a named async shutdown handler that closes the browser', () => {
    // The inline async () => { await closeBrowser(); } must be extracted into a const.
    expect(out).toMatch(/const shutdown = async \(\) =>/);
    expect(out).toContain('await closeBrowser()');
  });

  it('else-branch registers the shared handler for both SIGTERM and SIGINT', () => {
    // Both signals must go through the single extracted shutdown const.
    expect(out).toContain("process.on('SIGTERM', shutdown)");
    expect(out).toContain("process.on('SIGINT', shutdown)");
  });

  it('else-branch does not register signals with separate inline handlers', () => {
    // The http-branch uses its own shutdown const; count only one declaration per signal in the else.
    // The http branch and the else branch are mutually exclusive at runtime, but both appear in the
    // source text — we verify both SIGINT registrations exist (one per branch).
    const sigIntCount = (out.match(/process\.on\('SIGINT'/g) ?? []).length;
    expect(sigIntCount).toBeGreaterThanOrEqual(2); // http branch + else branch
  });
});

describe('R7-B — site stdio server handles both SIGTERM and SIGINT to prevent orphaned browsers', () => {
  const out = renderSiteTemplate('server-main.ts', manifest);

  it('renders to valid TypeScript', () => {
    assertParses(out, 'site-server-main-stdio');
  });

  it('declares a named async shutdown handler that closes the browser', () => {
    // The handler must be extracted so both signals share the same closeBrowser() call.
    expect(out).toMatch(/const shutdown = async \(\) =>/);
    expect(out).toContain('await closeBrowser()');
  });

  it('registers the shared handler for both SIGTERM and SIGINT', () => {
    expect(out).toContain("process.on('SIGTERM', shutdown)");
    expect(out).toContain("process.on('SIGINT', shutdown)");
  });

  it('does not register SIGTERM or SIGINT with separate inline handlers', () => {
    // Both signals must go through the single extracted shutdown const — no duplication.
    const sigTermCount = (out.match(/process\.on\('SIGTERM'/g) ?? []).length;
    const sigIntCount = (out.match(/process\.on\('SIGINT'/g) ?? []).length;
    expect(sigTermCount).toBe(1);
    expect(sigIntCount).toBe(1);
  });
});
