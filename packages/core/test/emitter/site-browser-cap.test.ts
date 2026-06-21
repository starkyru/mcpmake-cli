import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import ts from 'typescript';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renderSiteTemplate } from '../../src/emitter/site-template-loader.js';
import type { SiteProjectManifest } from '../../src/types/site.js';

// These tests load the REAL generated browser-manager + telemetry modules and
// drive them, mocking only true external boundaries:
//   - Playwright's `chromium` launcher (replaced with a recording fake module)
//   - the network (`fetch` stubbed — the "fake transport" the telemetry emitter
//     POSTs its event stream to)
// The capacity gate, idle eviction, teardown ordering and telemetry wiring under
// test are the real template code, not a reimplementation.

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

function transpile(src: string): string {
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

// A recording stand-in for the `playwright` chromium launcher. Each launch
// returns an independent browser whose `isConnected()` flips to false once
// closed, so the manager's relaunch logic exercises faithfully. Counters let
// tests assert exactly how many Chromium contexts were actually created.
const FAKE_PLAYWRIGHT = `
export const calls = { launches: 0, contexts: 0, pages: 0, contextCloses: 0, browserCloses: 0 };
// Created objects in creation order so a test can fire a crash/disconnect on one.
export const contexts = [];
export const pages = [];
export const browsers = [];
// Gates + injected failures for race/error tests.
const control = {
  holdLaunch: false, launchResolvers: [],
  holdClose: false, closeResolvers: [],
  holdNewContext: false, ncResolvers: [],
  holdBrowserClose: false, bcResolvers: [],
  failNewPage: false,
};
export function holdLaunch() { control.holdLaunch = true; }
export function releaseLaunch() {
  control.holdLaunch = false;
  for (const r of control.launchResolvers.splice(0)) r();
}
export function holdContextCloses() { control.holdClose = true; }
export function releaseContextCloses() {
  control.holdClose = false;
  for (const r of control.closeResolvers.splice(0)) r();
}
export function holdNewContext() { control.holdNewContext = true; }
export function releaseNewContext() {
  control.holdNewContext = false;
  for (const r of control.ncResolvers.splice(0)) r();
}
// Hold browser.close() suspended; real Playwright keeps isConnected()===true
// until the close completes, which is the window the manager must not reuse.
export function holdBrowserClose() { control.holdBrowserClose = true; }
export function releaseBrowserClose() {
  control.holdBrowserClose = false;
  for (const r of control.bcResolvers.splice(0)) r();
}
export function failNextNewPage() { control.failNewPage = true; }
// Simulate Chromium killing things out from under the server (events fire with
// no prior server-initiated close()/map deletion).
export function crashContext(i) { contexts[i].emit('close'); }
export function crashPage(i) { pages[i].emit('crash'); }
export function disconnectBrowser(i) { browsers[i].emit('disconnected'); }
function mkEmitter(target) {
  const handlers = {};
  target.on = (event, fn) => { (handlers[event] ||= []).push(fn); };
  target.emit = (event) => { for (const fn of handlers[event] || []) fn(); };
  return target;
}
export const chromium = {
  async launch() {
    if (control.holdLaunch) await new Promise((res) => control.launchResolvers.push(res));
    calls.launches++;
    let connected = true;
    const browser = mkEmitter({
      isConnected: () => connected,
      async newContext() {
        if (control.holdNewContext) await new Promise((res) => control.ncResolvers.push(res));
        calls.contexts++;
        const ctx = mkEmitter({
          async newPage() {
            if (control.failNewPage) { control.failNewPage = false; throw new Error('newPage failed'); }
            calls.pages++;
            const page = mkEmitter({ async screenshot() { return Buffer.from('png'); } });
            pages.push(page);
            return page;
          },
          async close() {
            calls.contextCloses++;
            if (control.holdClose) await new Promise((res) => control.closeResolvers.push(res));
            // Real Playwright fires 'close' when the context actually closes,
            // including for closes we initiated — the handler must no-op then.
            this.emit('close');
          },
        });
        contexts.push(ctx);
        return ctx;
      },
      async close() {
        calls.browserCloses++;
        if (control.holdBrowserClose) await new Promise((res) => control.bcResolvers.push(res));
        connected = false;
        // Real Playwright fires 'disconnected' when the browser process exits.
        this.emit('disconnected');
      },
    });
    browsers.push(browser);
    return browser;
  },
};
`;

interface ManagerModule {
  initBrowserManager(cfg: {
    headless: boolean;
    idleTimeoutMs: number;
    viewport: { width: number; height: number };
    maxSessions: number;
  }): void;
  getOrCreateSession(id?: string): Promise<{ page: unknown; sessionId: string }>;
  closeSession(id?: string): Promise<void>;
  closeBrowser(): Promise<void>;
  takeScreenshot(id?: string, fullPage?: boolean): Promise<Buffer>;
  listSessions(): string[];
}

interface FakeModule {
  calls: {
    launches: number;
    contexts: number;
    pages: number;
    contextCloses: number;
    browserCloses: number;
  };
  holdLaunch(): void;
  releaseLaunch(): void;
  holdContextCloses(): void;
  releaseContextCloses(): void;
  holdNewContext(): void;
  releaseNewContext(): void;
  holdBrowserClose(): void;
  releaseBrowserClose(): void;
  failNextNewPage(): void;
  crashContext(i: number): void;
  crashPage(i: number): void;
  disconnectBrowser(i: number): void;
}

interface TelemetryModule {
  flushOnShutdown(reason?: string): Promise<void>;
}

/** Render the real templates to ESM, swap the playwright import for the fake,
 *  and import a fresh module instance (unique dir defeats the module cache, so
 *  each test gets its own sessions map and re-reads process.env at load). */
async function loadManager(): Promise<{
  bm: ManagerModule;
  fake: FakeModule;
  telemetry: TelemetryModule;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'mcpmake-bm-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'fake-playwright.mjs'), FAKE_PLAYWRIGHT);
  writeFileSync(join(dir, 'telemetry.js'), transpile(renderSiteTemplate('telemetry.ts', manifest)));

  let bmSrc = transpile(renderSiteTemplate('browser-manager.ts', manifest));
  // The only real external boundary in this module is the Playwright launcher.
  bmSrc = bmSrc.replaceAll("from 'playwright'", "from './fake-playwright.mjs'");
  writeFileSync(join(dir, 'browser-manager.js'), bmSrc);

  const fake = (await import(pathToFileURL(join(dir, 'fake-playwright.mjs')).href)) as FakeModule;
  // The manager imports this same telemetry.js (same URL = same instance), so a
  // test can drive flushOnShutdown() to simulate the SIGTERM shutdown sequence.
  const telemetry = (await import(
    pathToFileURL(join(dir, 'telemetry.js')).href
  )) as TelemetryModule;
  const bm = (await import(pathToFileURL(join(dir, 'browser-manager.js')).href)) as ManagerModule;
  return { bm, fake, telemetry };
}

const baseConfig = (maxSessions: number, idleTimeoutMs = 300000) => ({
  headless: true,
  idleTimeoutMs,
  viewport: { width: 800, height: 600 },
  maxSessions,
});

const ORIGINAL_ENV = { ...process.env };
beforeAll(() => {
  // Each loadManager() adds SIGTERM/SIGINT listeners at module load; lift the
  // cap so repeated loads don't trip the MaxListeners warning.
  process.setMaxListeners(100);
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── config: env-configurable cap ───────────────────────────────────────────

describe('loadConfig — MCP_MAX_BROWSER_SESSIONS precedence', () => {
  async function loadConfigFn(): Promise<() => { browser: { maxSessions: number } }> {
    const dir = mkdtempSync(join(tmpdir(), 'mcpmake-cfg-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'config.js'), transpile(renderSiteTemplate('config.ts', manifest)));
    const mod = (await import(pathToFileURL(join(dir, 'config.js')).href)) as {
      loadConfig: () => { browser: { maxSessions: number } };
    };
    return mod.loadConfig;
  }

  it('uses MCP_MAX_BROWSER_SESSIONS when set to a positive integer', async () => {
    const loadConfig = await loadConfigFn();
    process.env.MCP_MAX_BROWSER_SESSIONS = '3';
    delete process.env.MAX_SESSIONS;
    expect(loadConfig().browser.maxSessions).toBe(3);
  });

  it('falls back to MAX_SESSIONS (legacy alias) when the new var is unset', async () => {
    const loadConfig = await loadConfigFn();
    delete process.env.MCP_MAX_BROWSER_SESSIONS;
    process.env.MAX_SESSIONS = '5';
    expect(loadConfig().browser.maxSessions).toBe(5);
  });

  it('lets MCP_MAX_BROWSER_SESSIONS win when both are set', async () => {
    const loadConfig = await loadConfigFn();
    process.env.MCP_MAX_BROWSER_SESSIONS = '3';
    process.env.MAX_SESSIONS = '5';
    expect(loadConfig().browser.maxSessions).toBe(3);
  });

  it('ignores an invalid MCP_MAX_BROWSER_SESSIONS and falls through', async () => {
    const loadConfig = await loadConfigFn();
    process.env.MCP_MAX_BROWSER_SESSIONS = 'abc';
    process.env.MAX_SESSIONS = '5';
    expect(loadConfig().browser.maxSessions).toBe(5);
  });

  it('ignores a non-positive MCP_MAX_BROWSER_SESSIONS and falls through to the manifest default', async () => {
    const loadConfig = await loadConfigFn();
    process.env.MCP_MAX_BROWSER_SESSIONS = '0';
    delete process.env.MAX_SESSIONS;
    // manifest browserConfig.maxSessions === 10 is baked in as DEFAULT_MAX_SESSIONS.
    expect(loadConfig().browser.maxSessions).toBe(10);
  });

  it('uses the baked manifest default when neither env var is set', async () => {
    const loadConfig = await loadConfigFn();
    delete process.env.MCP_MAX_BROWSER_SESSIONS;
    delete process.env.MAX_SESSIONS;
    expect(loadConfig().browser.maxSessions).toBe(10);
  });
});

// ─── hard concurrency cap ────────────────────────────────────────────────────

describe('browser manager — hard concurrency cap', () => {
  it('rejects the (N+1)th session with a clear error and never opens an extra context', async () => {
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(2));

    const a = await bm.getOrCreateSession('a');
    const b = await bm.getOrCreateSession('b');
    expect(a.sessionId).toBe('a');
    expect(b.sessionId).toBe('b');
    expect(fake.calls.contexts).toBe(2);

    await expect(bm.getOrCreateSession('c')).rejects.toThrow(/Browser session limit reached \(2\)/);
    // The rejected request must NOT have spawned a 3rd Chromium context.
    expect(fake.calls.contexts).toBe(2);
    expect(bm.listSessions().sort()).toEqual(['a', 'b']);
  });

  it('keeps existing sessions fully usable after the cap is hit', async () => {
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(1));

    const first = await bm.getOrCreateSession('a');
    await expect(bm.getOrCreateSession('b')).rejects.toThrow(/limit reached/);

    // Reusing the existing session returns the SAME page and opens no new context.
    const again = await bm.getOrCreateSession('a');
    expect(again.page).toBe(first.page);
    expect(fake.calls.contexts).toBe(1);

    const shot = await bm.takeScreenshot('a');
    expect(Buffer.isBuffer(shot)).toBe(true);
  });

  it('holds the cap under concurrent distinct-id creates (no TOCTOU overrun)', async () => {
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(2));

    // Fire five distinct-id creates simultaneously; the synchronous
    // reserve-before-await gate must admit exactly maxSessions and reject the rest
    // — never letting all five pass the check and then build five contexts.
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd', 'e'].map((id) => bm.getOrCreateSession(id)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    // Only two Chromium contexts were ever created.
    expect(fake.calls.contexts).toBe(2);
    expect(bm.listSessions()).toHaveLength(2);
  });

  it('single-flights concurrent no-id creates onto one shared default context', async () => {
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    const [r1, r2, r3] = await Promise.all([
      bm.getOrCreateSession(),
      bm.getOrCreateSession(),
      bm.getOrCreateSession(),
    ]);

    expect(r1.sessionId).toBe(r2.sessionId);
    expect(r2.sessionId).toBe(r3.sessionId);
    // All three receive the SAME real page — not a not-yet-assigned placeholder.
    expect(r1.page).toBeDefined();
    expect(r2.page).toBe(r1.page);
    expect(r3.page).toBe(r1.page);
    // One coalesced default context, not three racing ones.
    expect(fake.calls.contexts).toBe(1);
    expect(bm.listSessions()).toHaveLength(1);
  });
});

// ─── freeing a slot ──────────────────────────────────────────────────────────

describe('browser manager — a freed slot admits a new session', () => {
  it('closeSession frees a slot so the next create succeeds', async () => {
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(1));

    await bm.getOrCreateSession('a');
    await expect(bm.getOrCreateSession('b')).rejects.toThrow(/limit reached/);

    await bm.closeSession('a');
    expect(fake.calls.contextCloses).toBe(1);

    const b = await bm.getOrCreateSession('b');
    expect(b.sessionId).toBe('b');
    expect(fake.calls.contexts).toBe(2);
  });

  it('idle eviction frees a slot so the next create succeeds', async () => {
    vi.useFakeTimers();
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(1, 1000));

    await bm.getOrCreateSession('a');
    await expect(bm.getOrCreateSession('b')).rejects.toThrow(/limit reached/);

    // Advance past the idle window AND past the 30s reaper interval.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bm.listSessions()).not.toContain('a');

    const b = await bm.getOrCreateSession('b');
    expect(b.sessionId).toBe('b');
    expect(fake.calls.contexts).toBe(2);
  });
});

// ─── telemetry: exactly-once lifecycle via the fake transport ────────────────

describe('browser manager — telemetry lifecycle is exactly-once', () => {
  interface Ev {
    type: string;
    sessionId: string;
    reason?: string;
  }

  function enableTelemetryTransport(): Ev[] {
    process.env.MCPMAKE_TELEMETRY_URL = 'https://host.example/api/internal/browser-telemetry';
    process.env.MCPMAKE_TELEMETRY_TOKEN = 'tok';
    process.env.MCPMAKE_SERVER_SLUG = 'slug';
    const sent: Ev[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const payload = JSON.parse(init.body) as { events: Ev[] };
        sent.push(...payload.events);
        return new Response('{}', { status: 202 });
      }),
    );
    return sent;
  }

  const tick = () => new Promise((r) => setTimeout(r, 5));
  const endsFor = (sent: Ev[], id: string) =>
    sent.filter((e) => e.type === 'session_end' && e.sessionId === id);
  const startsFor = (sent: Ev[], id: string) =>
    sent.filter((e) => e.type === 'session_start' && e.sessionId === id);

  it('emits exactly one session_start per new context and none on reuse', async () => {
    const sent = enableTelemetryTransport();
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    await bm.getOrCreateSession('a');
    await bm.getOrCreateSession('a'); // reuse — no new context, no new start
    await bm.getOrCreateSession('b');
    expect(fake.calls.contexts).toBe(2);

    // closeBrowser flushes; the buffered start events ride along.
    await bm.closeBrowser();
    await tick();

    expect(startsFor(sent, 'a')).toHaveLength(1);
    expect(startsFor(sent, 'b')).toHaveLength(1);
    expect(sent.filter((e) => e.type === 'session_start')).toHaveLength(2);
  });

  it('emits exactly one session_end per explicit close', async () => {
    const sent = enableTelemetryTransport();
    const { bm } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    await bm.getOrCreateSession('a');
    await bm.closeSession('a');
    await tick();

    const ends = endsFor(sent, 'a');
    expect(ends).toHaveLength(1);
    expect(ends[0].reason).toBe('explicit');
  });

  it('emits exactly one session_end per session on shutdown', async () => {
    const sent = enableTelemetryTransport();
    const { bm } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    await bm.getOrCreateSession('a');
    await bm.getOrCreateSession('b');
    await bm.closeBrowser();
    await tick();

    expect(endsFor(sent, 'a')).toHaveLength(1);
    expect(endsFor(sent, 'b')).toHaveLength(1);
    expect(endsFor(sent, 'a')[0].reason).toBe('shutdown');
    expect(sent.filter((e) => e.type === 'session_end')).toHaveLength(2);
  });

  it('emits exactly one session_end(crash) and frees the slot when a context closes unexpectedly', async () => {
    const sent = enableTelemetryTransport();
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(1));

    await bm.getOrCreateSession('a');
    // Chromium crashes the context: 'close' fires without the server tearing it down.
    fake.crashContext(0);
    await tick();

    const ends = endsFor(sent, 'a');
    expect(ends).toHaveLength(1);
    expect(ends[0].reason).toBe('crash');
    expect(bm.listSessions()).not.toContain('a');

    // The slot is reclaimed: a new session can be created despite maxSessions=1.
    const b = await bm.getOrCreateSession('b');
    expect(b.sessionId).toBe('b');
    expect(endsFor(sent, 'b')).toHaveLength(0);
  });

  it('emits exactly one session_end when an explicit close races the idle sweep', async () => {
    // Regression guard: if closeSession deleted the entry only AFTER awaiting
    // context.close(), the idle reaper firing during that await would ALSO end
    // the same (idle) session — a double session_end that pins host occupancy.
    // Claiming the teardown synchronously makes this exactly-once.
    vi.useFakeTimers();
    const sent = enableTelemetryTransport();
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(5, 1000));

    await bm.getOrCreateSession('a');
    // Age the session past its idle window without firing the 30s reaper yet.
    await vi.advanceTimersByTimeAsync(1500);

    // Pin context.close() open so closeSession genuinely suspends at its await
    // (otherwise the close microtask resolves before the reaper and there is no
    // race). The synchronous prefix of closeSession must remove 'a' from the
    // pool BEFORE that await, so the reaper firing below cannot also claim it.
    fake.holdContextCloses();
    const closing = bm.closeSession('a');
    // Fire the reaper while the explicit close is suspended mid-teardown.
    await vi.advanceTimersByTimeAsync(30_000);
    // Let the close finish and its session_end flush.
    fake.releaseContextCloses();
    await closing;
    await vi.advanceTimersByTimeAsync(5);

    const ends = endsFor(sent, 'a');
    expect(ends).toHaveLength(1);
    expect(ends[0].reason).toBe('explicit');
  });

  it('emits exactly one session_end(crash) and closes the context when the page renderer crashes', async () => {
    const sent = enableTelemetryTransport();
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(1));

    await bm.getOrCreateSession('a');
    // Renderer process dies; the context object itself is still nominally alive.
    fake.crashPage(0);
    await tick();

    const ends = endsFor(sent, 'a');
    expect(ends).toHaveLength(1);
    expect(ends[0].reason).toBe('crash');
    expect(bm.listSessions()).not.toContain('a');
    // The crash path closed the context (1 close) — it is not leaked.
    expect(fake.calls.contextCloses).toBe(1);

    const b = await bm.getOrCreateSession('b');
    expect(b.sessionId).toBe('b');
  });

  it('reclaims every session with one session_end each when the browser process disconnects', async () => {
    const sent = enableTelemetryTransport();
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    await bm.getOrCreateSession('a');
    await bm.getOrCreateSession('b');
    // The whole browser process dies out from under the server.
    fake.disconnectBrowser(0);
    await tick();

    expect(endsFor(sent, 'a')).toHaveLength(1);
    expect(endsFor(sent, 'b')).toHaveLength(1);
    expect(endsFor(sent, 'a')[0].reason).toBe('crash');
    expect(bm.listSessions()).toEqual([]);

    // The pool is freed and the manager relaunches the browser for new work.
    const c = await bm.getOrCreateSession('c');
    expect(c.sessionId).toBe('c');
  });

  it('emits exactly one session_end when a suspended close races flushOnShutdown (SIGTERM)', async () => {
    // Regression guard: on SIGTERM, shutdown() runs closeBrowser() then
    // telemetry.flushOnShutdown(). A closeSession suspended at await
    // context.close() has already left the session pool but is still open in
    // telemetry; flushOnShutdown ends it, then the suspended close ends it AGAIN.
    // The idempotent sessionEnded (keyed on openSessions) collapses this to one.
    const sent = enableTelemetryTransport();
    const { bm, fake, telemetry } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    await bm.getOrCreateSession('a');

    fake.holdContextCloses();
    const closing = bm.closeSession('a');

    // Reproduce the shutdown() sequence explicitly.
    await bm.closeBrowser();
    await telemetry.flushOnShutdown();

    fake.releaseContextCloses();
    await closing;
    await tick();

    const ends = endsFor(sent, 'a');
    expect(ends).toHaveLength(1);
    // closeSession claimed + ended 'a' synchronously before its await, so its
    // 'explicit' end is the one that survives; flushOnShutdown finds no open 'a'.
    expect(ends[0].reason).toBe('explicit');
  });

  it('meters a same-id session re-created mid-teardown as its own start/end pair', async () => {
    // Regression guard for the openSessions-token leak: if a teardown emitted
    // session_end only AFTER awaiting context.close(), a session re-created
    // under the same id during that await would share the single token and have
    // its own end suppressed (leaked occupancy). Ending synchronously on claim
    // gives each instance its own token.
    const sent = enableTelemetryTransport();
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    await bm.getOrCreateSession('a'); // instance #1

    // closeSession #1 suspends at await context.close().
    fake.holdContextCloses();
    const closing = bm.closeSession('a');

    // A new request reuses id 'a' while #1 is still tearing down → instance #2.
    const a2 = await bm.getOrCreateSession('a');
    expect(a2.sessionId).toBe('a');

    fake.releaseContextCloses();
    await closing;
    await tick();

    // Tear down instance #2; its end must NOT be suppressed by #1's.
    await bm.closeBrowser();
    await tick();

    expect(startsFor(sent, 'a')).toHaveLength(2);
    expect(endsFor(sent, 'a')).toHaveLength(2);
  });

  it('relaunches rather than handing out a browser that is mid-close', async () => {
    // Regression guard: closeBrowser awaiting browser.close() must null `browser`
    // first, or a concurrent create gets the dying instance (isConnected() stays
    // true mid-close) and returns an instantly-dead session.
    const sent = enableTelemetryTransport();
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    await bm.getOrCreateSession('a');

    // Drive teardown so closeBrowser is suspended at browser.close() with the
    // browser still reporting connected (the window the manager must not reuse).
    fake.holdBrowserClose();
    const closing = bm.closeBrowser();
    await tick(); // let closeBrowser reach the held browser.close()

    // A new request arrives while the browser is mid-teardown.
    const b = await bm.getOrCreateSession('b');

    fake.releaseBrowserClose();
    await closing;
    await tick();

    // 'b' is a live session on a freshly relaunched browser, not the dying one.
    expect(b.sessionId).toBe('b');
    expect(bm.listSessions()).toContain('b');
    expect(fake.calls.launches).toBe(2);
    const shot = await bm.takeScreenshot('b');
    expect(Buffer.isBuffer(shot)).toBe(true);
    // 'b' was never crash-ended (it never sat on the dying browser).
    expect(endsFor(sent, 'b')).toHaveLength(0);
  });

  it('does not orphan a context or emit a stray session_end when shutdown races an in-flight create', async () => {
    const sent = enableTelemetryTransport();
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    // One resident session so the browser is already launched.
    await bm.getOrCreateSession('a');

    // Begin creating 'b' but suspend inside newContext (before its context
    // exists) — a SIGTERM landing mid cold-start.
    fake.holdNewContext();
    const creating = bm.getOrCreateSession('b');

    // Shutdown: closeBrowser ends 'a' (started) and must skip 'b' (a reserved,
    // unstarted slot) — no session_end without a session_start.
    await bm.closeBrowser();

    // The in-flight create resumes; it must ABORT and close the context it
    // creates rather than orphan a live Chromium context outside the pool.
    fake.releaseNewContext();
    await expect(creating).rejects.toThrow(/aborted|shut down/i);
    await tick();

    expect(startsFor(sent, 'b')).toHaveLength(0);
    expect(endsFor(sent, 'b')).toHaveLength(0);
    expect(endsFor(sent, 'a')).toHaveLength(1);
    expect(bm.listSessions()).toEqual([]);
    // Two contexts created (a, aborted-b); BOTH closed — neither leaked.
    expect(fake.calls.contexts).toBe(2);
    expect(fake.calls.contextCloses).toBe(2);
  });
});

// ─── idle reaper fairness ────────────────────────────────────────────────────

describe('browser manager — idle reaper is not starved by active sessions', () => {
  it('evicts an idle session even while a sibling is continuously accessed', async () => {
    vi.useFakeTimers();
    const { bm } = await loadManager();
    bm.initBrowserManager(baseConfig(5, 1000)); // idle threshold 1s

    await bm.getOrCreateSession('busy');
    await bm.getOrCreateSession('idle');

    // Refresh 'busy' just before the fixed 30s reaper tick; never touch 'idle'.
    await vi.advanceTimersByTimeAsync(29_500);
    await bm.getOrCreateSession('busy'); // reuse → refresh lastAccessedAt
    await vi.advanceTimersByTimeAsync(500); // total 30s → reaper fires

    // A reaper that reset on every access would never fire in a busy container,
    // leaving 'idle' resident. With a fixed-cadence reaper, 'idle' is evicted
    // (untouched > 1s) while 'busy' (touched 500ms ago) survives.
    expect(bm.listSessions()).toContain('busy');
    expect(bm.listSessions()).not.toContain('idle');
  });
});

// ─── failed creation leaks nothing ───────────────────────────────────────────

describe('browser manager — a failed creation leaks neither slot nor context', () => {
  it('closes the created context and frees the slot when newPage throws', async () => {
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(1));

    fake.failNextNewPage();
    await expect(bm.getOrCreateSession('a')).rejects.toThrow(/newPage failed/);

    // Slot released (cap not pinned) and the orphan context was closed.
    expect(bm.listSessions()).toEqual([]);
    expect(fake.calls.contexts).toBe(1);
    expect(fake.calls.contextCloses).toBe(1);

    // A subsequent create succeeds at maxSessions=1 — the slot was truly freed.
    const b = await bm.getOrCreateSession('b');
    expect(b.sessionId).toBe('b');
  });
});

describe('browser manager — shutdown is a launch lifecycle barrier', () => {
  it('closes a Chromium process whose launch completes after closeBrowser begins', async () => {
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(1));

    fake.holdLaunch();
    const creating = bm.getOrCreateSession('a');
    await new Promise((r) => setTimeout(r, 5));

    const closing = bm.closeBrowser();
    fake.releaseLaunch();

    await expect(creating).rejects.toThrow(/launch aborted|shut down/i);
    await closing;

    expect(bm.listSessions()).toEqual([]);
    expect(fake.calls.launches).toBe(1);
    expect(fake.calls.browserCloses).toBe(1);
  });
});

// ─── reserved (mid-creation) slots are not exposed as usable sessions ─────────

describe('browser manager — a mid-creation slot is not a usable session', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('hides a reserved slot from listSessions and rejects takeScreenshot on it', async () => {
    const { bm, fake } = await loadManager();
    bm.initBrowserManager(baseConfig(5));

    // Suspend the create inside newContext: 'a' is reserved with no context yet.
    fake.holdNewContext();
    const creating = bm.getOrCreateSession('a');
    await tick();

    expect(bm.listSessions()).not.toContain('a');
    // Must be the clear "No active session" error, not a TypeError on undefined.page.
    await expect(bm.takeScreenshot('a')).rejects.toThrow(/No active session/);

    // Once creation completes the session becomes usable.
    fake.releaseNewContext();
    await creating;
    expect(bm.listSessions()).toContain('a');
    const shot = await bm.takeScreenshot('a');
    expect(Buffer.isBuffer(shot)).toBe(true);
  });
});
