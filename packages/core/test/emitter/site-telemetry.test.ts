import { describe, it, expect, afterEach, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderSiteTemplate } from '../../src/emitter/site-template-loader.js';
import type { SiteProjectManifest } from '../../src/types/site.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_TEMPLATE_DIR = resolve(__dirname, '../../src/emitter/site-templates');

const manifest: SiteProjectManifest = {
  serverName: 'example-site',
  serverVersion: '1.0.0',
  baseUrl: 'https://example.com',
  transport: 'http',
  siteDescriptor: {
    siteId: 'site_x',
    baseUrl: 'https://example.com',
    pages: [],
    analyzedAt: '2026-06-20T00:00:00.000Z',
    version: 1,
    crawlDepth: 1,
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

/** Transpile the rendered telemetry template to an ESM file and import it fresh
 *  (a unique path defeats the module cache, so each call re-reads process.env). */
async function loadTelemetryModule(): Promise<
  typeof import('../../src/emitter/site-templates/telemetry.ts.hbs')
> {
  const src = renderSiteTemplate('telemetry.ts', manifest);
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), 'mcpmake-telemetry-'));
  const file = join(dir, 'telemetry.mjs');
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser-session telemetry template', () => {
  it('renders to valid TypeScript', () => {
    const out = renderSiteTemplate('telemetry.ts', manifest);
    const result = ts.transpileModule(out, {
      compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    const errors = (result.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    expect(errors).toHaveLength(0);
  });

  it('gates entirely on MCPMAKE_TELEMETRY_URL + token + slug', () => {
    const src = readFileSync(resolve(SITE_TEMPLATE_DIR, 'telemetry.ts.hbs'), 'utf-8');
    expect(src).toContain('process.env.MCPMAKE_TELEMETRY_URL');
    expect(src).toContain(
      'Boolean(TELEMETRY_URL) && Boolean(TELEMETRY_TOKEN) && Boolean(SERVER_SLUG)',
    );
    // Every public entry early-returns when disabled.
    expect(src).toMatch(/export function sessionStarted[\s\S]*?if \(!ENABLED\) return;/);
    expect(src).toMatch(/export function sessionEnded[\s\S]*?if \(!ENABLED\) return;/);
  });

  it('does NOT phone home when telemetry env is unset (self-host)', async () => {
    delete process.env.MCPMAKE_TELEMETRY_URL;
    delete process.env.MCPMAKE_TELEMETRY_TOKEN;
    delete process.env.MCPMAKE_SERVER_SLUG;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await loadTelemetryModule();
    mod.sessionStarted('s1');
    mod.sessionEnded('s1', 'explicit');
    await mod.flushOnShutdown();
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs slug-scoped events to the ingest URL when enabled', async () => {
    process.env.MCPMAKE_TELEMETRY_URL = 'https://host.example/api/internal/browser-telemetry';
    process.env.MCPMAKE_TELEMETRY_TOKEN = 'mf_secret';
    process.env.MCPMAKE_SERVER_SLUG = 'my-slug';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await loadTelemetryModule();
    mod.sessionStarted('s1');
    mod.sessionEnded('s1', 'idle'); // triggers a flush
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://host.example/api/internal/browser-telemetry');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mf_secret');
    const payload = JSON.parse(init.body as string);
    expect(payload.slug).toBe('my-slug');
    const types = payload.events.map((e: { type: string }) => e.type);
    expect(types).toContain('session_start');
    expect(types).toContain('session_end');
  });
});

describe('browser-manager wires the telemetry emit points', () => {
  const src = readFileSync(resolve(SITE_TEMPLATE_DIR, 'browser-manager.ts.hbs'), 'utf-8');

  it('imports the telemetry module', () => {
    expect(src).toContain("import * as telemetry from './telemetry.js';");
  });

  it('emits session_start when a context becomes resident', () => {
    // Right before createSession returns the new page.
    const startIdx = src.indexOf('telemetry.sessionStarted(id);');
    const returnIdx = src.indexOf('return { page, sessionId: id };');
    expect(startIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(returnIdx);
  });

  it('emits session_end with the correct reason at each teardown', () => {
    expect(src).toContain("telemetry.sessionEnded(id, 'explicit');"); // closeSession
    expect(src).toContain("telemetry.sessionEnded(id, 'idle');"); // idle timer
    expect(src).toContain("telemetry.sessionEnded(id, 'shutdown');"); // closeBrowser
  });

  it('flushes telemetry on process shutdown', () => {
    expect(src).toContain('await telemetry.flushOnShutdown();');
    expect(src).toContain('async function shutdown()');
  });
});
