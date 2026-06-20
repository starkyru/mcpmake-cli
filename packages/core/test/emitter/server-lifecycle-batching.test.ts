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
