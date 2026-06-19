import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../../src/emitter/template-loader.js';
import { scaffoldSharedModules } from '../../src/emitter/project-scaffolder.js';
import type { ProjectManifest } from '../../src/types/index.js';

const here = dirname(fileURLToPath(import.meta.url));

// Render the trace template to a temp module under the repo (so vitest's
// transform pipeline compiles it) and import it to exercise the real code.
const tmpFile = join(here, `__trace_runtime_${process.pid}.ts`);
/* eslint-disable @typescript-eslint/no-explicit-any */
let trace: any;

beforeAll(async () => {
  writeFileSync(tmpFile, renderTemplate('trace.ts', {}));
  trace = await import(/* @vite-ignore */ tmpFile);
});

afterAll(() => {
  rmSync(tmpFile, { force: true });
});

describe('trace runtime — parseTraceparent', () => {
  it('parses a valid header', () => {
    const r = trace.parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(r).toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', flags: '01' });
  });

  it('rejects malformed, all-zero, and missing headers', () => {
    expect(trace.parseTraceparent(undefined)).toBeNull();
    expect(trace.parseTraceparent('garbage')).toBeNull();
    expect(trace.parseTraceparent('00-xyz-abc-01')).toBeNull();
    // all-zero trace id is invalid per the spec
    expect(
      trace.parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
    ).toBeNull();
  });
});

describe('trace runtime — deriveContext / formatTraceparent', () => {
  it('continues an inbound trace id and mints a fresh span', () => {
    const ctx = trace.deriveContext('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ctx.flags).toBe('01');
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    // a new span, not the inbound parent id
    expect(ctx.spanId).not.toBe('00f067aa0ba902b7');
  });

  it('starts a fresh sampled trace when none is supplied', () => {
    const ctx = trace.deriveContext(undefined);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.flags).toBe('01');
  });

  it('round-trips through formatTraceparent', () => {
    const ctx = trace.deriveContext('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
    expect(trace.formatTraceparent(ctx)).toBe(
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${ctx.spanId}-00`,
    );
  });

  it('captures tracestate when present', () => {
    const ctx = trace.deriveContext(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'vendor=value',
    );
    expect(ctx.traceState).toBe('vendor=value');
  });
});

describe('trace runtime — AsyncLocalStorage propagation', () => {
  it('exposes trace headers inside runWithTrace, including across awaits', async () => {
    const ctx = trace.deriveContext(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'vendor=value',
    );
    const headers = await trace.runWithTrace(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1)); // cross an async boundary
      return trace.traceHeaders();
    });
    expect(headers.traceparent).toBe(trace.formatTraceparent(ctx));
    expect(headers.tracestate).toBe('vendor=value');
  });

  it('returns no headers outside a traced context', () => {
    expect(trace.traceHeaders()).toEqual({});
    expect(trace.currentTrace()).toBeUndefined();
  });
});

describe('trace wiring — emitted project', () => {
  const manifest: ProjectManifest = {
    serverName: 'trace-test',
    serverVersion: '1.0.0',
    baseUrl: 'https://api.example.com',
    transport: 'http',
    tools: [],
    authSchemes: [],
    envVars: [],
  };

  it('emits src/trace.ts and wires the server + executor', () => {
    const units = scaffoldSharedModules(manifest);

    const traceUnit = units.find((u) => u.filePath === 'src/trace.ts');
    expect(traceUnit).toBeTruthy();
    expect(traceUnit!.content).toContain('export function traceHeaders');

    const server = units.find((u) => u.filePath === 'src/index.ts')!.content;
    expect(server).toContain("from './trace.js'");
    expect(server).toContain('runWithTrace');
    expect(server).toContain("req.headers['traceparent']");

    const executor = units.find((u) => u.filePath === 'src/http.ts')!.content;
    expect(executor).toContain("import { traceHeaders } from './trace.js'");
    expect(executor).toContain('...traceHeaders()');
  });

  it('emits src/trace.ts for stdio projects too (executor imports it)', () => {
    const units = scaffoldSharedModules({ ...manifest, transport: 'stdio' });
    expect(units.find((u) => u.filePath === 'src/trace.ts')).toBeTruthy();
  });
});
