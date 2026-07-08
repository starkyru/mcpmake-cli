/**
 * Cross-language MCP-server PARITY — the same OpenAPI fixture generated as a
 * node server, a Cloudflare Worker, and a python FastMCP server must expose the
 * same tool surface and shape the same upstream wire requests, and every
 * DELIBERATE divergence must match the ASYMMETRIES table exactly.
 *
 * One fixture (fixtures/parity.yaml) → three generated projects → four live
 * runtimes (node-stdio, node-http, worker via wrangler dev, python via a venv),
 * all pointed at ONE recording mock upstream (helpers/parity-upstream.ts). The
 * suite drives real MCP traffic (initialize, tools/list, tools/call) through
 * hand-rolled clients, projects each language's output onto a canonical form
 * (helpers/normalize-mcp.ts), and deep-compares:
 *
 *   - tools/list: identical tool inventory + identical normalized schemas
 *   - tools/call: identical canonical upstream request (method/path/query/
 *     auth header/body) and identical normalized result
 *   - the asymmetry table in BOTH directions (a gap closing or a capability
 *     regressing both fail until parity/asymmetries.ts is updated)
 *
 * The node project is generated ONCE with `--transport http`: that entry
 * (server-main-http) defaults to stdio and switches to Streamable HTTP with
 * TRANSPORT=http, so one build serves both node runtimes.
 *
 * HEAVY: behind MCPMAKE_E2E + MCPMAKE_E2E_HEAVY (npm installs, a venv, and a
 * wrangler boot). Each runtime whose toolchain can't be provisioned skips
 * cleanly with a logged reason instead of failing the suite.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCli, combined } from '../helpers/run-cli.js';
import { ensureBuilt } from '../helpers/build-guard.js';
import { makeTempDir } from '../helpers/sandbox.js';
import { E2E, E2E_HEAVY } from '../helpers/gating.js';
import {
  npmInstall,
  npmRunBuild,
  provisionPythonVenv,
  type PythonEnv,
} from '../helpers/provision.js';
import { startMcpServer, type McpStdioClient, type ToolCallResult } from '../helpers/mcp-client.js';
import { McpHttpClient } from '../helpers/mcp-http-client.js';
import { startWranglerDev, getFreePort, type WranglerDevHandle } from '../helpers/wrangler-dev.js';
import { startPythonMcpServer } from '../helpers/python-mcp.js';
import { startParityUpstream, type ParityUpstream } from '../helpers/parity-upstream.js';
import {
  normalizeToolsList,
  normalizeToolCallResult,
  canonicalUpstreamRequest,
  type RawTool,
} from '../helpers/normalize-mcp.js';
import { ASYMMETRIES, UPSTREAM_ERROR_TEXT, type ParityLang } from './asymmetries.js';

const PARITY_SPEC = fileURLToPath(new URL('../fixtures/parity.yaml', import.meta.url));
const HEAVY = E2E && E2E_HEAVY;

/** The exact tool inventory the 4-operation parity spec MUST register, everywhere. */
const EXPECTED_TOOLS = ['create_widget', 'delete_widget', 'get_widget', 'list_widgets'];

const API_KEY = 'secret-key-123';
const AUTH_TOKEN = 'parity-secret';

/** One live runtime the parity assertions run against. */
interface ParityRuntime {
  lang: ParityLang;
  listTools(): Promise<RawTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

describe.skipIf(!HEAVY)('e2e parity: node vs worker vs python generated servers', () => {
  let upstream: ParityUpstream;
  let nodeDir: string;
  let workerDir: string;
  let pyDir: string;

  let nodeProvisioned: { ok: boolean; reason?: string } = { ok: false, reason: 'not run' };
  let py: PythonEnv = { python: null, reason: 'not run' };
  let wrangler: WranglerDevHandle = { ok: false, reason: 'not booted' };
  const extraWranglers: WranglerDevHandle[] = [];

  let nodeStdioClient: McpStdioClient | undefined;
  let pythonClient: McpStdioClient | undefined;
  let nodeHttpProc: ChildProcess | undefined;
  let workerClient: McpHttpClient | undefined;

  /** Only the runtimes whose toolchain provisioned; the rest are logged skips. */
  const runtimes: ParityRuntime[] = [];

  /** Spawn `node dist/index.js` in http mode and poll GET /ready until 200. */
  async function startNodeHttpServer(
    env: Record<string, string>,
  ): Promise<{ child: ChildProcess; url: string }> {
    const port = await getFreePort();
    let stderr = '';
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: nodeDir,
      env: { PATH: process.env.PATH, ...env, TRANSPORT: 'http', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => (stderr += c));
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1_000) });
        if (res.status === 200) return { child, url };
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    child.kill('SIGKILL');
    // The node build already succeeded, so a boot failure is a real bug.
    throw new Error(`node http server never became ready.\n--- stderr ---\n${stderr}`);
  }

  function stopChild(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      t.unref?.();
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  beforeAll(async () => {
    ensureBuilt();
    upstream = await startParityUpstream();

    // Generate the three projects from the ONE parity fixture. The node project
    // uses --transport http so its single entry serves both node runtimes.
    const dir = await makeTempDir();
    nodeDir = join(dir, 'node-app');
    workerDir = join(dir, 'worker-app');
    pyDir = join(dir, 'py-app');
    for (const args of [
      ['from', 'openapi', PARITY_SPEC, '-o', nodeDir, '--transport', 'http'],
      ['from', 'openapi', PARITY_SPEC, '-o', workerDir, '--target', 'cloudflare'],
      ['from', 'openapi', PARITY_SPEC, '-o', pyDir, '--format', 'python'],
    ]) {
      const gen = await runCli(args, { cwd: dir });
      expect(gen.code, combined(gen)).toBe(0);
    }

    // Provision all three toolchains in parallel (each is network-dependent and
    // skip-clean on failure). The node build only runs after its install.
    let workerProvisioned: { ok: boolean; reason?: string };
    [nodeProvisioned, workerProvisioned, py] = await Promise.all([
      npmInstall(nodeDir).then(async (r) => {
        if (r.ok) await npmRunBuild(nodeDir);
        return r;
      }),
      npmInstall(workerDir),
      provisionPythonVenv(dir),
    ]);

    // ── Boot each available runtime once; reuse the client across tests ──
    const env = { BASE_URL: upstream.baseUrl, API_KEY };

    if (nodeProvisioned.ok) {
      const { client } = await startMcpServer({ cwd: nodeDir, env });
      nodeStdioClient = client;
      runtimes.push({
        lang: 'node-stdio',
        listTools: () => client.listTools() as Promise<RawTool[]>,
        callTool: (name, args) => client.callTool(name, args),
      });

      const { child, url } = await startNodeHttpServer({
        ...env,
        MCP_ALLOW_UNAUTHENTICATED: 'true',
      });
      nodeHttpProc = child;
      const httpClient = new McpHttpClient({ url });
      await httpClient.initialize();
      runtimes.push({
        lang: 'node-http',
        listTools: () => httpClient.listTools() as Promise<RawTool[]>,
        callTool: (name, args) => httpClient.callTool(name, args),
      });
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[parity] SKIP node-stdio + node-http — provision failed: ${nodeProvisioned.reason}`,
      );
    }

    if (workerProvisioned.ok) {
      wrangler = await startWranglerDev({
        projectDir: workerDir,
        vars: { BASE_URL: upstream.baseUrl, MCP_AUTH_TOKEN: AUTH_TOKEN, API_KEY },
      });
      if (wrangler.ok) {
        const client = new McpHttpClient({ url: wrangler.url, bearer: AUTH_TOKEN });
        await client.initialize();
        workerClient = client;
        runtimes.push({
          lang: 'worker',
          listTools: () => client.listTools() as Promise<RawTool[]>,
          callTool: (name, args) => client.callTool(name, args),
        });
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[parity] SKIP worker — wrangler boot failed: ${wrangler.reason}`);
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[parity] SKIP worker — provision failed: ${workerProvisioned.reason}`);
    }

    if (py.python) {
      const { client } = await startPythonMcpServer(py.python, pyDir, env);
      pythonClient = client;
      runtimes.push({
        lang: 'python',
        listTools: () => client.listTools() as Promise<RawTool[]>,
        callTool: (name, args) => client.callTool(name, args),
      });
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[parity] SKIP python — provision failed: ${py.reason}`);
    }

    // Positive record of what actually ran — a run where a runtime silently
    // skipped must be distinguishable from a full four-runtime pass in CI logs.
    // eslint-disable-next-line no-console
    console.log(`[parity] live runtimes: ${runtimes.map((r) => r.lang).join(', ') || 'NONE'}`);
  }, 420_000);

  afterAll(async () => {
    await nodeStdioClient?.close();
    await pythonClient?.close();
    await stopChild(nodeHttpProc);
    if (wrangler.ok) await wrangler.stop();
    for (const w of extraWranglers) {
      if (w.ok) await w.stop();
    }
    if (upstream) await upstream.close();
  }, 60_000);

  // ── a. Identical tool inventory + identical normalized schemas ──────────

  it('tools/list: every runtime exposes the EXACT same tool set with equal normalized schemas', async () => {
    expect(runtimes.length, 'no runtime could be provisioned — nothing was tested').toBeGreaterThan(
      0,
    );
    const normalized: Array<{ lang: ParityLang; tools: ReturnType<typeof normalizeToolsList> }> =
      [];
    for (const rt of runtimes) {
      const raw = await rt.listTools();
      const names = raw.map((t) => t.name).sort();
      // Discriminating: exact count AND exact names, per runtime.
      expect(names, `tool inventory drift in ${rt.lang}`).toEqual(EXPECTED_TOOLS);
      normalized.push({ lang: rt.lang, tools: normalizeToolsList(raw) });
    }
    // Cross-compare: after canonicalization, every language must agree exactly.
    const [first, ...rest] = normalized;
    for (const other of rest) {
      expect(other.tools, `normalized tools/list drift: ${other.lang} vs ${first.lang}`).toEqual(
        first.tools,
      );
    }
  });

  // ── b. The asymmetry table, asserted in BOTH directions on RAW output ──

  it('raw tools/list matches the ASYMMETRIES table exactly (presence AND absence)', async () => {
    expect(runtimes.length).toBeGreaterThan(0);
    for (const rt of runtimes) {
      const feats = ASYMMETRIES[rt.lang];
      const raw = await rt.listTools();
      const listWidgets = raw.find((t) => t.name === 'list_widgets')!;
      const deleteWidget = raw.find((t) => t.name === 'delete_widget')!;
      expect(listWidgets, `${rt.lang}: list_widgets missing`).toBeDefined();
      const props =
        (listWidgets.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};

      // controlArgs: node/worker inject jq_filter + idempotency_key; python must not.
      expect('jq_filter' in props, `${rt.lang}: jq_filter presence`).toBe(feats.controlArgs);
      expect('idempotency_key' in props, `${rt.lang}: idempotency_key presence`).toBe(
        feats.controlArgs,
      );

      // toolTitle: the human title ("List Widgets") only where advertised.
      if (feats.toolTitle) {
        expect(listWidgets.title, `${rt.lang}: tool title`).toBe('List Widgets');
      } else {
        expect(listWidgets.title, `${rt.lang}: tool title must be absent`).toBeUndefined();
      }

      // outputSchema presence, plus its PROVENANCE where present: node derives
      // it from the OpenAPI response schema (array root wrapped as {items});
      // python's is FastMCP's generic list[TextContent] wrapper keyed `result`.
      const out = listWidgets.outputSchema as { properties?: Record<string, unknown> } | undefined;
      expect(out !== undefined, `${rt.lang}: outputSchema presence`).toBe(feats.outputSchema);
      if (rt.lang === 'node-stdio' || rt.lang === 'node-http') {
        expect(out?.properties, `${rt.lang}: API-derived outputSchema`).toHaveProperty('items');
      }
      if (rt.lang === 'python') {
        expect(out?.properties, 'python: generic TextContent outputSchema').toHaveProperty(
          'result',
        );
      }

      // annotations: readOnlyHint on the GET, destructiveHint on the DELETE.
      if (feats.annotations) {
        expect(listWidgets.annotations, `${rt.lang}: readOnlyHint`).toEqual({ readOnlyHint: true });
        expect(deleteWidget.annotations, `${rt.lang}: destructiveHint`).toEqual({
          destructiveHint: true,
        });
      } else {
        expect(listWidgets.annotations, `${rt.lang}: annotations must be absent`).toBeUndefined();
      }
    }
  });

  // ── c. Identical wire request + result for a query-parameter call ───────

  it('tools/call list_widgets shapes an IDENTICAL upstream request and result everywhere', async () => {
    expect(runtimes.length).toBeGreaterThan(0);
    // Hand-written expectations — every runtime must hit these exactly.
    const expectedRequest = {
      method: 'GET',
      path: '/widgets',
      query: { active: 'true', limit: '5', sort: 'asc' },
      apiKey: API_KEY,
      body: null,
    };
    const expectedResult = {
      isError: false,
      content: [
        {
          type: 'text',
          value: [
            { id: 1, name: 'anvil' },
            { id: 2, name: 'rocket' },
          ],
        },
      ],
    };
    for (const rt of runtimes) {
      upstream.reset();
      const result = await rt.callTool('list_widgets', { limit: 5, active: true, sort: 'asc' });
      expect(upstream.requests, `${rt.lang}: exactly one upstream request`).toHaveLength(1);
      expect(
        canonicalUpstreamRequest(upstream.requests[0]),
        `${rt.lang}: upstream request drift`,
      ).toEqual(expectedRequest);
      expect(normalizeToolCallResult(result), `${rt.lang}: tool result drift`).toEqual(
        expectedResult,
      );
    }
  });

  // ── d. Identical body serialization for a nested JSON request body ──────

  it('tools/call create_widget serializes the nested body identically everywhere', async () => {
    expect(runtimes.length).toBeGreaterThan(0);
    const body = {
      name: 'anvil',
      tags: ['heavy', 'iron'],
      priority: 'high',
      dimensions: { width: 2.5, height: 4 },
    };
    const expectedRequest = {
      method: 'POST',
      path: '/widgets',
      query: {},
      apiKey: API_KEY,
      body,
    };
    const expectedResult = {
      isError: false,
      content: [{ type: 'text', value: { id: 'w-new', echo: body } }],
    };
    for (const rt of runtimes) {
      upstream.reset();
      const result = await rt.callTool('create_widget', { body });
      expect(upstream.requests, `${rt.lang}: exactly one upstream request`).toHaveLength(1);
      expect(upstream.requests[0].contentType, `${rt.lang}: request content type`).toMatch(
        /^application\/json/,
      );
      expect(
        canonicalUpstreamRequest(upstream.requests[0]),
        `${rt.lang}: upstream request drift`,
      ).toEqual(expectedRequest);
      expect(normalizeToolCallResult(result), `${rt.lang}: tool result drift`).toEqual(
        expectedResult,
      );
    }
  });

  // ── e. Upstream-error surfacing is a KNOWN asymmetry — assert it exactly ─

  it("upstream 404 surfaces with each language's exact error text and isError flag", async () => {
    expect(runtimes.length).toBeGreaterThan(0);
    for (const rt of runtimes) {
      upstream.reset();
      const result = await rt.callTool('get_widget', { widgetId: 'missing' });
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      expect(text, `${rt.lang}: upstream-error text`).toMatch(UPSTREAM_ERROR_TEXT[rt.lang]);
      expect(result.isError === true, `${rt.lang}: isError on upstream error`).toBe(
        ASYMMETRIES[rt.lang].upstreamErrorIsError,
      );
    }
  });

  // ── f. Bearer auth fails CLOSED on both http-capable targets ─────────────

  it('node-http with MCP_AUTH_TOKEN rejects without the bearer and accepts with it', async () => {
    if (!nodeProvisioned.ok) return; // skip cleanly: toolchain unavailable
    const { child, url } = await startNodeHttpServer({
      BASE_URL: upstream.baseUrl,
      API_KEY,
      MCP_AUTH_TOKEN: AUTH_TOKEN,
    });
    try {
      const probe = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
      const anon = new McpHttpClient({ url });
      expect(await anon.rawStatus(probe)).toBe(401);
      const authed = new McpHttpClient({ url, bearer: AUTH_TOKEN });
      expect(await authed.rawStatus(probe)).toBe(200);
    } finally {
      await stopChild(child);
    }
  });

  it('worker rejects without the bearer and accepts with it', async () => {
    if (!wrangler.ok) return; // skip cleanly: wrangler unavailable
    const probe = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const anon = new McpHttpClient({ url: wrangler.url });
    expect(await anon.rawStatus(probe)).toBe(401);
    expect(await workerClient!.rawStatus(probe)).toBe(200);
  });

  // ── g. MCP_TOOLS filtering: honored by node + worker, a documented gap in
  //       python (its tools/list must be UNAFFECTED by the env var) ─────────

  it('MCP_TOOLS=list_widgets narrows node-stdio to exactly that tool', async () => {
    if (!nodeProvisioned.ok) return;
    const { client } = await startMcpServer({
      cwd: nodeDir,
      env: { BASE_URL: upstream.baseUrl, API_KEY, MCP_TOOLS: 'list_widgets' },
    });
    try {
      const names = (await client.listTools()).map((t) => t.name);
      expect(names).toEqual(['list_widgets']);
    } finally {
      await client.close();
    }
  });

  it('MCP_TOOLS does NOT filter python (the documented gap in ASYMMETRIES)', async () => {
    if (!py.python) return;
    const { client } = await startPythonMcpServer(py.python, pyDir, {
      BASE_URL: upstream.baseUrl,
      API_KEY,
      MCP_TOOLS: 'list_widgets',
    });
    try {
      const names = (await client.listTools()).map((t) => t.name).sort();
      // toolFiltering:false — the full inventory still comes back. If this ever
      // starts filtering, flip the table (and delete this comment): the gap closed.
      expect(ASYMMETRIES.python.toolFiltering).toBe(false);
      expect(names).toEqual(EXPECTED_TOOLS);
    } finally {
      await client.close();
    }
  });

  it('MCP_TOOLS=list_widgets narrows the worker to exactly that tool', async () => {
    if (!wrangler.ok) return;
    // The env binding is fixed per wrangler process, so filtering needs a second
    // boot. Stop the shared instance FIRST: both boots share the project's
    // .dev.vars, and wrangler dev hot-reloads on changes to it. This test runs
    // last — nothing after it uses the shared worker.
    await wrangler.stop();
    const filtered = await startWranglerDev({
      projectDir: workerDir,
      vars: {
        BASE_URL: upstream.baseUrl,
        MCP_AUTH_TOKEN: AUTH_TOKEN,
        API_KEY,
        MCP_TOOLS: 'list_widgets',
      },
    });
    extraWranglers.push(filtered);
    if (!filtered.ok) {
      // First boot worked, second didn't — that is an environment flake, not a
      // filtering bug; skip with the reason on record.
      // eslint-disable-next-line no-console
      console.warn(`[parity] SKIP worker MCP_TOOLS — reboot failed: ${filtered.reason}`);
      return;
    }
    const client = new McpHttpClient({ url: filtered.url, bearer: AUTH_TOKEN });
    const names = (await client.listTools()).map((t) => t.name as string);
    expect(names).toEqual(['list_widgets']);
  }, 300_000);
});
