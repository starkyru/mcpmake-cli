/**
 * Minimal Streamable-HTTP JSON-RPC MCP client for the parity suite.
 *
 * The stdio client (mcp-client.ts) frames newline-delimited JSON on a pipe;
 * this is its HTTP twin: each request is one `POST /mcp` carrying one JSON-RPC
 * message. The generated node http server answers through the SDK's
 * StreamableHTTPServerTransport, which frames responses as SSE
 * (`content-type: text/event-stream`, JSON in `data:` lines) even for a single
 * message; the generated worker answers plain JSON. This client accepts both,
 * so it doubles as the check that either framing is valid Streamable HTTP.
 * Like the stdio client it is hand-rolled (no @modelcontextprotocol/sdk) so it
 * can never pass by sharing transport code with the server under test.
 */

export const HTTP_CLIENT_PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcHttpResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpHttpClientOptions {
  /** Base URL of the server (e.g. http://127.0.0.1:8787) — /mcp is appended. */
  url: string;
  /** Bearer token sent as `Authorization: Bearer <token>` (omit for none). */
  bearer?: string;
  timeoutMs?: number;
}

/** Extract the JSON payload from either a plain-JSON or SSE-framed response body. */
function parseRpcBody(contentType: string, body: string): unknown {
  if (contentType.includes('text/event-stream')) {
    // Take the LAST data: line — the response message (earlier events may be
    // notifications or keep-alives on the same stream).
    const dataLines = body
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice('data:'.length).trim())
      .filter(Boolean);
    if (dataLines.length === 0) {
      throw new Error(`SSE response carried no data: lines:\n${body}`);
    }
    return JSON.parse(dataLines[dataLines.length - 1]);
  }
  return JSON.parse(body);
}

export class McpHttpClient {
  private readonly endpoint: string;
  private readonly bearer: string | undefined;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(opts: McpHttpClientOptions) {
    this.endpoint = `${opts.url.replace(/\/$/, '')}/mcp`;
    this.bearer = opts.bearer;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      // The SDK transport requires the client to accept both framings.
      accept: 'application/json, text/event-stream',
    };
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    return h;
  }

  /** POST an arbitrary body and return just the HTTP status (auth tests). */
  async rawStatus(body: unknown): Promise<number> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Drain so the socket is reusable.
    await res.text();
    return res.status;
  }

  /** Send one JSON-RPC request and await its (possibly SSE-framed) response. */
  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcHttpResponse> {
    const id = this.nextId++;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await res.text();
    if (res.status !== 200) {
      throw new Error(`POST /mcp (${method}) returned HTTP ${res.status}:\n${body}`);
    }
    const msg = parseRpcBody(res.headers.get('content-type') ?? '', body) as JsonRpcHttpResponse;
    if (msg.id !== id) {
      throw new Error(`response id mismatch for ${method}: sent ${id}, got ${String(msg.id)}`);
    }
    return msg;
  }

  /** Fire a JSON-RPC notification; returns the HTTP status (expect 202/204). */
  private async notify(method: string, params: Record<string, unknown> = {}): Promise<number> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await res.text();
    return res.status;
  }

  /** Full MCP startup handshake. Returns the server's serverInfo. */
  async initialize(): Promise<{ name: string; version: string }> {
    const res = await this.request('initialize', {
      protocolVersion: HTTP_CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcpmake-e2e-http', version: '0.0.0' },
    });
    if (res.error) throw new Error(`initialize failed: ${res.error.message}`);
    const ackStatus = await this.notify('notifications/initialized');
    if (ackStatus !== 202 && ackStatus !== 204) {
      throw new Error(`notifications/initialized expected 202/204, got HTTP ${ackStatus}`);
    }
    return (res.result?.serverInfo ?? {}) as { name: string; version: string };
  }

  /** List the tools the server advertises. Throws on a JSON-RPC error. */
  async listTools(): Promise<Array<Record<string, unknown>>> {
    const res = await this.request('tools/list', {});
    if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
    return (res.result?.tools ?? []) as Array<Record<string, unknown>>;
  }

  /** Call a tool. Returns the tool result envelope (content/isError). */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`tools/call(${name}) failed: ${res.error.message}`);
    return (res.result ?? {}) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
  }
}
