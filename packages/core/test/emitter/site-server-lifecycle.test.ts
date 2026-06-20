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
});
