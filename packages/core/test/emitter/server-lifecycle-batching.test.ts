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

const httpData = {
  serverName: 'lifecycle-api',
  serverVersion: '1.0.0',
  tools: [{ name: 'a' }],
  hasResources: false,
  hasPrompts: false,
  hasOAuth: false,
  hasAsyncTools: false,
};

const workerData = {
  serverName: 'lifecycle-worker',
  serverVersion: '1.0.0',
};

describe('R4-C(b) — HTTP listener outer try/catch guards against process crash', () => {
  const src = renderTemplate('server-main-http.ts', httpData);

  it('renders parseable TypeScript with the outer guard in place', () => {
    assertParses(src, 'server-main-http-outer-guard');
  });

  it('wraps the listener body in a top-level try/catch that logs and sends 500', () => {
    // The outer try must appear immediately inside the async listener.
    expect(src).toMatch(/createServer\(async \(req, res\) => \{\s*try \{/);
    // On error: log via the structured logger.
    expect(src).toContain("log('error', 'Unhandled error in request handler'");
    // Guard against double-send: only write if no headers yet.
    expect(src).toContain('if (!res.headersSent)');
    // 500 response uses the file's sendJson helper.
    expect(src).toMatch(/sendJson\(res, 500,/);
  });
});

describe('D-H7 — stateful HTTP session lifecycle bounds', () => {
  const src = renderTemplate('server-main-http.ts', httpData);

  it('renders parseable TypeScript', () => {
    assertParses(src, 'server-main-http');
  });

  it('caps the live session count and rejects new sessions at capacity', () => {
    expect(src).toContain('MCP_MAX_SESSIONS');
    expect(src).toMatch(/sessions\.size >= MAX_SESSIONS/);
    // The rejection path must short-circuit (return) before creating a server.
    expect(src).toMatch(/at session capacity/i);
  });

  it('stamps a last-access time and evicts idle sessions on access + via a reaper', () => {
    expect(src).toContain('lastAccess');
    expect(src).toContain('SESSION_IDLE_MS');
    expect(src).toContain('evictIdleSessions');
    // Periodic reaper that does not keep the process alive on its own.
    expect(src).toMatch(/setInterval\(\(\) => evictIdleSessions/);
    expect(src).toMatch(/reaper\.unref\(\)/);
    // On-access sweep inside the stateful branch.
    expect(src).toMatch(/evictIdleSessions\(now\)/);
  });

  it('clears the reaper and closes every session on shutdown', () => {
    expect(src).toMatch(/clearInterval\(reaper\)/);
    expect(src).toContain('sessions.clear()');
  });
});

describe('R7-A — HTTP server handles both SIGTERM and SIGINT via a shared shutdown handler', () => {
  const src = renderTemplate('server-main-http.ts', httpData);

  it('renders parseable TypeScript', () => {
    assertParses(src, 'server-main-http-sigint');
  });

  it('declares a named shutdown const that accepts a signal name', () => {
    // R8-C: the handler takes (signal: string) so the log message names the actual signal.
    expect(src).toMatch(/const shutdown = \(signal: string\) =>/);
  });

  it('registers signal-specific lambdas that pass the signal name through', () => {
    // R8-C: each registration passes its own signal string so the log is accurate.
    expect(src).toContain("process.on('SIGTERM', () => shutdown('SIGTERM'))");
    expect(src).toContain("process.on('SIGINT', () => shutdown('SIGINT'))");
  });

  it('shutdown log message uses the interpolated signal name', () => {
    expect(src).toMatch(/\$\{signal\} received, shutting down/);
  });

  it('shutdown handler clears the reaper interval', () => {
    expect(src).toMatch(/clearInterval\(reaper\)/);
  });

  it('shutdown handler arms a forced-exit backstop that does not keep the loop alive', () => {
    expect(src).toMatch(/setTimeout\(.*5000\)\.unref\(\)/s);
  });
});

describe('D-M5 — worker JSON-RPC batch concurrency bound', () => {
  const src = renderWorkerTemplate('worker.ts', workerData);

  it('renders parseable TypeScript', () => {
    assertParses(src, 'worker');
  });

  it('caps batch length and rejects oversized/empty batches', () => {
    expect(src).toContain('MAX_BATCH');
    expect(src).toMatch(/parsed\.length > MAX_BATCH/);
    expect(src).toMatch(/Batch too large/);
    expect(src).toMatch(/parsed\.length === 0/);
  });

  it('processes the batch through a bounded-concurrency pool (no Promise.all fan-out)', () => {
    expect(src).toContain('mapWithConcurrency');
    expect(src).toContain('BATCH_CONCURRENCY');
    // The unbounded Promise.all(parsed.map(...)) fan-out must be gone.
    expect(src).not.toMatch(/Promise\.all\(\s*parsed\.map/);
  });
});
