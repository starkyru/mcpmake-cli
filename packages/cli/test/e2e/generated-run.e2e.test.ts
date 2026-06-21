/**
 * Sprint E6 Tier-B — a generated node server doesn't just compile, it RUNS and
 * speaks MCP correctly.
 *
 * Tier-A proves `tsc` is happy; Tier-B is the real proof of life: install →
 * build → spawn `node dist/index.js` → perform the actual MCP stdio handshake
 * with a hand-rolled JSON-RPC client (helpers/mcp-client.ts), then assert the
 * EXACT tool inventory the petstore spec must yield. A server that compiles can
 * still register zero tools, crash on `initialize`, or write logs to stdout
 * (which corrupts the transport) — none of those survive this test.
 *
 * The single `tools/call` runs against a throwaway local HTTP mock standing in
 * for the upstream API, asserting request shaping (method, path, query, the
 * `X-API-Key` auth header derived from the spec's apiKey scheme) AND response
 * mapping (the upstream JSON comes back as the tool's text content). No real
 * network upstream is ever contacted — BASE_URL is pinned at the mock.
 *
 * HEAVY: behind `MCPMAKE_E2E` + `MCPMAKE_E2E_HEAVY`. On an offline box the
 * install step skips the suite cleanly rather than failing.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { makeTempDir } from './helpers/sandbox.js';
import { E2E, E2E_HEAVY } from './helpers/gating.js';
import { npmInstall, npmRunBuild } from './helpers/provision.js';
import { startMcpServer, type McpStdioClient } from './helpers/mcp-client.js';

const PETSTORE = fileURLToPath(new URL('../fixtures/petstore.yaml', import.meta.url));
const HEAVY = E2E && E2E_HEAVY;

/** The exact tool inventory the 4-operation petstore spec MUST register (snake_case names). */
const EXPECTED_TOOLS = ['create_pet', 'delete_pet', 'list_pets', 'show_pet_by_id'];

interface CapturedRequest {
  method: string;
  url: string;
  apiKey: string | undefined;
}

describe.skipIf(!HEAVY)('e2e Tier-B: generated node server runs + MCP handshake', () => {
  let projectDir: string;
  let provisioned: { ok: boolean; reason?: string } = { ok: false, reason: 'not run' };
  let upstream: Server;
  let upstreamPort: number;
  let lastRequest: CapturedRequest | null = null;

  beforeAll(async () => {
    ensureBuilt();

    // Local mock upstream: records the request and returns a fixed pet list.
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          apiKey: req.headers['x-api-key'] as string | undefined,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 7, name: 'Rex' }]));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    // Generate, install, build the curated node project.
    const dir = await makeTempDir();
    projectDir = join(dir, 'run-app');
    const gen = await runCli(['from', 'openapi', PETSTORE, '-o', projectDir], { cwd: dir });
    expect(gen.code, combined(gen)).toBe(0);

    provisioned = await npmInstall(projectDir);
    if (!provisioned.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[E6 Tier-B] SKIP run/handshake — provision failed: ${provisioned.reason}`);
      return;
    }
    await npmRunBuild(projectDir);
  }, 300_000);

  afterAll(async () => {
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('initialize → tools/list returns the EXACT petstore tool set', async () => {
    if (!provisioned.ok) return; // skip cleanly when offline
    let client: McpStdioClient | undefined;
    try {
      const { client: c, serverInfo } = await startMcpServer({
        cwd: projectDir,
        env: { BASE_URL: `http://127.0.0.1:${upstreamPort}`, API_KEY: 'unused-for-list' },
      });
      client = c;
      // serverInfo is bound to the spec (title → package name).
      expect(serverInfo.name).toBe('swagger-petstore');
      expect(serverInfo.version).toBe('1.0.0');

      const tools = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Discriminating: exact count AND exact names. A regression that drops or
      // renames a tool, or registers extras, fails here.
      expect(names).toEqual(EXPECTED_TOOLS);
      expect(tools).toHaveLength(4);
    } finally {
      await client?.close();
    }
  });

  it('tools/call shapes the upstream request (path/query/auth header) and maps the response', async () => {
    if (!provisioned.ok) return;
    let client: McpStdioClient | undefined;
    try {
      lastRequest = null;
      const { client: c } = await startMcpServer({
        cwd: projectDir,
        env: { BASE_URL: `http://127.0.0.1:${upstreamPort}`, API_KEY: 'secret-key-123' },
      });
      client = c;

      const result = await client.callTool('list_pets', { limit: 5 });

      // Request shaping: GET /pets?limit=5 with the spec's X-API-Key auth header.
      expect(lastRequest).not.toBeNull();
      expect(lastRequest!.method).toBe('GET');
      expect(lastRequest!.url).toBe('/pets?limit=5');
      expect(lastRequest!.apiKey).toBe('secret-key-123');

      // Response mapping: the upstream JSON body is returned as the tool's text content.
      expect(result.isError).not.toBe(true);
      const text = result.content?.find((c2) => c2.type === 'text')?.text ?? '';
      const parsed = JSON.parse(text) as Array<{ id: number; name: string }>;
      expect(parsed).toEqual([{ id: 7, name: 'Rex' }]);
    } finally {
      await client?.close();
    }
  });

  it('server logs go to stderr, never stdout (stdout must stay pure JSON-RPC)', async () => {
    if (!provisioned.ok) return;
    let client: McpStdioClient | undefined;
    try {
      const { client: c } = await startMcpServer({
        cwd: projectDir,
        env: { BASE_URL: `http://127.0.0.1:${upstreamPort}`, API_KEY: 'x' },
      });
      client = c;
      await client.listTools();
      // The startup banner the server prints must land on stderr — if any banner
      // text reached stdout, the JSON-RPC parser in mcp-client would have thrown.
      expect(client.capturedStderr).toContain('swagger-petstore MCP server running on stdio');
    } finally {
      await client?.close();
    }
  });
});
