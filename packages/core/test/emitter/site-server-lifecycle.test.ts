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

    // The per-request server is what gets connected in the HTTP request handler —
    // the request path connects `reqServer`, never a shared `server` reference.
    expect(out).toContain('await reqServer.connect(transport);');
    expect(out).toMatch(
      /await\s+reqServer\.connect\(transport\);\s*await\s+transport\.handleRequest/,
    );

    // The old shared-server connect-per-request anti-pattern is gone: the only
    // bare `server.connect(...)` in this template is the single stdio else-branch,
    // never inside the HTTP request handler. (Whitespace-tolerant unlike an exact
    // two-line snippet match.) `new McpServer(` must appear exactly once — inside
    // the factory — not as a shared module-level singleton plus a factory.
    const newServerCount = (out.match(/new McpServer\(/g) ?? []).length;
    expect(newServerCount).toBe(1);
    // `server.connect` (the shared-global pattern) must not be used in the HTTP
    // branch; only `reqServer.connect` is. The bare `server.connect` belongs to the
    // stdio else-branch and lives after `} else {`.
    const httpBranch = out.slice(0, out.indexOf('} else {'));
    expect(httpBranch).not.toMatch(/(?<!req)\bserver\.connect\(transport\)/);
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

  // The template is `if (process.env.TRANSPORT === 'http') { ... } else { ... }`.
  // `} else {` appears exactly once, so it cleanly partitions the rendered source
  // into the http branch (before) and the stdio else branch (after). Every R8-B
  // assertion targets the else branch specifically, so we slice it out here — a
  // substring/count over the whole file would be satisfied by the http branch and
  // could not detect a regression that drops lifecycle handling from the else branch.
  const elseDelimiter = '} else {';
  const delimiterCount = out.split(elseDelimiter).length - 1;

  it('renders to valid TypeScript', () => {
    assertParses(out, 'site-server-main-http-stdio-sigint');
  });

  it('has exactly one if/else split so the branch slicing below is unambiguous', () => {
    // Guards the slicing assumption: if a second `} else {` ever appears, the
    // slices below would no longer correspond to the two transport branches.
    expect(delimiterCount).toBe(1);
  });

  it('else-branch declares its own named async shutdown handler that closes the browser', () => {
    // The inline async () => { await closeBrowser(); } must be extracted into a const
    // *inside the else branch*. The http branch has its own shutdown const, so we must
    // look only at the text after `} else {`.
    const elseBranch = out.slice(out.indexOf(elseDelimiter) + elseDelimiter.length);
    expect(elseBranch).toMatch(/const shutdown = async \(\) =>/);
    expect(elseBranch).toContain('await closeBrowser()');
    // The extracted handler must exit the process once the browser is closed.
    expect(elseBranch).toContain('process.exit(0)');
  });

  it('else-branch registers the shared handler for both SIGTERM and SIGINT', () => {
    // Both signals must go through the single extracted shutdown const, and the
    // registrations must live in the else branch (not just the http branch above).
    const elseBranch = out.slice(out.indexOf(elseDelimiter) + elseDelimiter.length);
    expect(elseBranch).toContain("process.on('SIGTERM', shutdown)");
    expect(elseBranch).toContain("process.on('SIGINT', shutdown)");
  });

  it('else-branch routes each signal through the single shutdown const, with no inline handlers', () => {
    // The anti-pattern this guards is registering a signal with a fresh inline
    // handler (e.g. process.on('SIGINT', () => ...)) or registering a signal twice.
    // Within the else branch each signal must appear exactly once and bind `shutdown`.
    const elseBranch = out.slice(out.indexOf(elseDelimiter) + elseDelimiter.length);

    const sigTermRegs = elseBranch.match(/process\.on\('SIGTERM',[^)]*\)/g) ?? [];
    const sigIntRegs = elseBranch.match(/process\.on\('SIGINT',[^)]*\)/g) ?? [];

    expect(sigTermRegs).toEqual(["process.on('SIGTERM', shutdown)"]);
    expect(sigIntRegs).toEqual(["process.on('SIGINT', shutdown)"]);

    // And the else branch must not introduce an inline arrow/function directly in a
    // process.on(...) call — every signal goes through the named const.
    expect(elseBranch).not.toMatch(/process\.on\('SIG(TERM|INT)',\s*(async\s*)?\(/);
  });

  it('http-branch keeps its own shutdown handling independent of the else-branch', () => {
    // Sanity check that the slicing is real: the http branch (before `} else {`)
    // also has a shutdown const and both signal registrations, proving the else-branch
    // assertions above are not accidentally reading the http branch's lifecycle code.
    const httpBranch = out.slice(0, out.indexOf(elseDelimiter));
    expect(httpBranch).toMatch(/const shutdown = async \(\) =>/);
    expect(httpBranch).toContain("process.on('SIGTERM', shutdown)");
    expect(httpBranch).toContain("process.on('SIGINT', shutdown)");
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
