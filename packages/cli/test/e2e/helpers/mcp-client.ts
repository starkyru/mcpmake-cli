/**
 * Minimal stdio JSON-RPC MCP client for Tier-B e2e tests (Sprint E6).
 *
 * Tier-A proves a generated server *compiles/imports*; Tier-B proves it actually
 * *runs* and speaks MCP. To do that we have to be a real client: spawn the built
 * server, perform the `initialize` handshake, send the `notifications/initialized`
 * acknowledgement, then drive `tools/list` / `tools/call` over newline-delimited
 * JSON-RPC on stdin/stdout — exactly what Claude Desktop / Cursor do.
 *
 * We deliberately do NOT depend on `@modelcontextprotocol/sdk` here: this client
 * lives in the repo's own test tree (the SDK is not a repo dependency), and a
 * hand-rolled framing client is the strongest possible check that the generated
 * server's wire protocol is correct on its own terms — it can't accidentally
 * pass by sharing transport code with the server. The server's stdout is pure
 * JSON-RPC (its logs go to stderr), so line-delimited parsing is sufficient.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** The protocol revision we negotiate. The generated node server accepts this. */
export const CLIENT_PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface SpawnServerOptions {
  /** Working directory for the server process (the generated project dir). */
  cwd: string;
  /** Env handed to the server (e.g. BASE_URL pointed at a mock, API_KEY). */
  env?: Record<string, string>;
  /** Command to run (default: process.execPath = node). */
  command?: string;
  /** Args (default: ['dist/index.js']). */
  args?: string[];
  /** Per-request timeout. */
  requestTimeoutMs?: number;
}

/**
 * A live MCP client bound to one spawned server. Create with {@link startMcpServer},
 * always `await client.close()` in a `finally`.
 */
export class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private stderr = '';
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(opts: SpawnServerOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.child = spawn(opts.command ?? process.execPath, opts.args ?? ['dist/index.js'], {
      cwd: opts.cwd,
      // Positive-ish: inherit PATH for node resolution, then layer the caller's
      // env. A test pins BASE_URL/API_KEY so the server can't reach a real API.
      env: { PATH: process.env.PATH, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => (this.stderr += chunk));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      // Fail any in-flight requests — the server died before answering.
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`server exited (code=${code}, signal=${signal}) with pending request`));
      }
      this.pending.clear();
    });
  }

  /** Server stderr captured so far (the generated server logs banners here). */
  get capturedStderr(): string {
    return this.stderr;
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    // Newline-delimited JSON-RPC. Tolerate blank lines.
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        // A non-JSON stdout line means the server is writing logs to stdout —
        // that corrupts the transport for a real MCP client. Surface it loudly.
        throw new Error(`non-JSON line on server stdout (corrupts MCP transport): ${trimmed}`);
      }
      const waiter = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pending.delete(msg.id);
        waiter.resolve(msg);
      }
      // Notifications / unrequested messages are ignored.
    }
  }

  /** Send a JSON-RPC request and await the matching response (by id). */
  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (this.exited) {
      return Promise.reject(
        new Error(
          `cannot send "${method}": server already exited (${JSON.stringify(this.exitInfo)})`,
        ),
      );
    }
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request "${method}" (id=${id}) timed out after ${this.requestTimeoutMs}ms.\n` +
              `--- server stderr ---\n${this.stderr}`,
          ),
        );
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response). */
  private notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /**
   * Perform the full MCP startup handshake: `initialize` then the
   * `notifications/initialized` ack. Returns the server's `serverInfo`.
   */
  async initialize(): Promise<{ name: string; version: string }> {
    const res = await this.request('initialize', {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcpmake-e2e', version: '0.0.0' },
    });
    if (res.error) {
      throw new Error(`initialize failed: ${res.error.message}`);
    }
    this.notify('notifications/initialized');
    return (res.result?.serverInfo ?? {}) as { name: string; version: string };
  }

  /** List the tools the server advertises. Throws on a JSON-RPC error. */
  async listTools(): Promise<McpTool[]> {
    const res = await this.request('tools/list', {});
    if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
    return (res.result?.tools ?? []) as McpTool[];
  }

  /** Call a tool. Returns the tool result envelope (content/isError). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`tools/call(${name}) failed: ${res.error.message}`);
    return (res.result ?? {}) as ToolCallResult;
  }

  /** Terminate the server and resolve once it has exited (or after a short grace). */
  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (this.exited) return resolve();
      const t = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 3_000);
      t.unref?.();
      this.child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/** Spawn a server and complete the handshake; returns a ready client + serverInfo. */
export async function startMcpServer(
  opts: SpawnServerOptions,
): Promise<{ client: McpStdioClient; serverInfo: { name: string; version: string } }> {
  const client = new McpStdioClient(opts);
  const serverInfo = await client.initialize();
  return { client, serverInfo };
}
