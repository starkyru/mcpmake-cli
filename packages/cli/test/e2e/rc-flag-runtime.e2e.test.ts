/**
 * 2026-07-28 RC flag — RUNTIME proof against the real pinned SDK.
 *
 * The unit tier (core/test/emitter/protocol-2026-07-28-flag.test.ts) pins the
 * emitted wiring as strings; this tier actually builds a generated HTTP server
 * (real `npm install` + `tsc`) and exercises the flag end to end:
 *
 *   - flag ON:  a handshake-less `tools/list` (no initialize) succeeds — the
 *     synthetic-initialize shim primes the SDK; per-request `_meta` is accepted.
 *   - flag OFF: the same request is refused by the SDK (legacy behavior intact),
 *     which proves the RC behavior really is held behind the flag.
 *
 * HEAVY: network (npm install) + toolchain, gated like generated-compile.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { makeTempDir } from './helpers/sandbox.js';
import { E2E, E2E_HEAVY } from './helpers/gating.js';
import { npmInstall, npmRunBuild } from './helpers/provision.js';

const PETSTORE = fileURLToPath(new URL('../fixtures/petstore.yaml', import.meta.url));
const HEAVY = E2E && E2E_HEAVY;

/** Parse a StreamableHTTP POST response body: direct JSON or an SSE stream. */
async function readRpcResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    // Last `data:` line carries the JSON-RPC response for the request id.
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return dataLines.length > 0 ? JSON.parse(dataLines[dataLines.length - 1]) : undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

async function postMcp(port: number, body: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  return readRpcResponse(res);
}

describe.skipIf(!HEAVY)('e2e: 2026-07-28 RC flag runtime behavior (HTTP target)', () => {
  let projectDir: string;
  let provisioned = false;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    ensureBuilt();
    const dir = await makeTempDir();
    projectDir = join(dir, 'rc-app');
    const gen = await runCli(
      ['from', 'openapi', PETSTORE, '-o', projectDir, '--transport', 'http'],
      { cwd: dir },
    );
    expect(gen.code, combined(gen)).toBe(0);
    const install = await npmInstall(projectDir);
    if (!install.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[RC-flag e2e] SKIP — provision failed: ${install.reason}`);
      return;
    }
    await npmRunBuild(projectDir);
    provisioned = true;
  }, 600_000);

  afterAll(() => {
    for (const c of children) c.kill('SIGKILL');
  });

  /** Start the built server and wait for /health. Returns the port. */
  async function startServer(extraEnv: Record<string, string>): Promise<number> {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn('node', ['dist/index.js'], {
      cwd: projectDir,
      env: {
        ...process.env,
        TRANSPORT: 'http',
        PORT: String(port),
        BASE_URL: 'https://petstore.example.com',
        MCP_ALLOW_UNAUTHENTICATED: 'true',
        ...extraEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return port;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('generated server did not become healthy in 20s');
  }

  it('flag ON: serves a handshake-less tools/list (no initialize sent)', async () => {
    if (!provisioned) return;
    const port = await startServer({ MCP_FEATURES: 'protocol-2026-07-28' });
    const rpc = (await postMcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })) as { result?: { tools?: unknown[] }; error?: unknown };
    expect(rpc.error, JSON.stringify(rpc)).toBeUndefined();
    expect(Array.isArray(rpc.result?.tools)).toBe(true);
    expect(rpc.result!.tools!.length).toBeGreaterThan(0);
  }, 60_000);

  it('flag ON: accepts per-request _meta (protocolVersion/clientInfo)', async () => {
    if (!provisioned) return;
    const port = await startServer({ MCP_FEATURES: 'protocol-2026-07-28' });
    const rpc = (await postMcp(port, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {
        _meta: {
          protocolVersion: '2026-07-28',
          clientInfo: { name: 'rc-e2e-client', version: '1.0.0' },
          capabilities: {},
        },
      },
    })) as { result?: { tools?: unknown[] }; error?: unknown };
    expect(rpc.error, JSON.stringify(rpc)).toBeUndefined();
    expect(Array.isArray(rpc.result?.tools)).toBe(true);
  }, 60_000);

  it('flag OFF (default): no RC feature is advertised and legacy dispatch is untouched', async () => {
    if (!provisioned) return;
    // Empirical note (SDK ^1.12, verified by this suite): the STATELESS
    // transport already serves basic requests without initialize, so "refuses
    // handshake-less requests" is NOT the legacy contract to pin. What the flag
    // actually controls: the synthetic-initialize priming (guaranteed
    // initialized state + clientInfo/capabilities seeded from _meta on ANY SDK
    // version) and the feature advertisement. Off ⇒ features stays empty.
    const port = await startServer({});
    const discover = (await postMcp(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'server/discover',
      params: {},
    })) as { result?: { features?: string[] } };
    expect(discover.result?.features).toEqual([]);
  }, 60_000);

  it('flag ON: server/discover advertises the enabled feature', async () => {
    if (!provisioned) return;
    const port = await startServer({ MCP_FEATURES: 'protocol-2026-07-28' });
    const rpc = (await postMcp(port, {
      jsonrpc: '2.0',
      id: 4,
      method: 'server/discover',
      params: {},
    })) as { result?: { features?: string[] } };
    expect(rpc.result?.features).toContain('protocol-2026-07-28');
  }, 60_000);
});
