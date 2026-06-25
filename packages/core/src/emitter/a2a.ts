/**
 * A2A (Agent2Agent) output (`--a2a`): wrap a generated MCP server in the published,
 * stable A2A protocol surface so A2A-speaking clients can discover and drive it.
 *
 * Two artifacts are derived deterministically from the project manifest:
 *
 *   1. An A2A **AgentCard** (served at `/.well-known/agent.json`) — every value comes
 *      from the manifest (server name/version, base URL, generated tool list, auth
 *      schemes). One A2A *skill* is emitted per generated MCP tool, so an A2A client
 *      sees the same capability surface MCP clients see via `tools/list`.
 *
 *   2. A JSON-RPC 2.0 **server-wrapper module** (`src/a2a.ts`) that implements the A2A
 *      transport methods `message/send` and `tasks/get` and serves the AgentCard. It
 *      maps an inbound A2A message to an MCP `tools/call` on the SAME generated server
 *      (via an in-process loopback MCP client — public SDK API only, no internals).
 *
 * PURE: a deterministic function of the inputs, with every interpolated value safely
 * encoded (tool descriptions/names come from the source API and are JSON.stringify'd
 * into the generated source, so no character can break out of a string literal or the
 * emitted JSON). No Date.now()/random — identical input yields byte-identical output.
 *
 * Conformance: AgentCard fields (name, description, version, url, protocolVersion,
 * capabilities, defaultInputModes, defaultOutputModes, skills, provider) and the
 * AgentSkill shape (id, name, description, tags) are the published A2A AgentCard
 * surface; the JSON-RPC methods `message/send`/`tasks/get` are the stable A2A v0.3.0
 * transport methods.
 */

/** Published, stable A2A protocol version this wrapper targets. */
export const A2A_PROTOCOL_VERSION = '0.3.0';

/** The path the AgentCard is served from (the A2A well-known discovery location). */
export const A2A_AGENT_CARD_PATH = '/.well-known/agent.json';

/** A generated tool, as the AgentCard's skill list needs to see it. */
export interface A2aTool {
  name: string;
  /** Human title (falls back to `name` when absent). */
  title?: string;
  description?: string;
}

/** Inputs the AgentCard is derived from — a thin projection of ProjectManifest. */
export interface A2aCardInputs {
  serverName: string;
  serverVersion: string;
  baseUrl: string;
  tools: readonly A2aTool[];
}

/** An A2A AgentSkill (the published subset we can derive without fabrication). */
export interface A2aSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

/** An A2A AgentCard (the published subset we can derive from the manifest). */
export interface A2aAgentCard {
  name: string;
  description: string;
  version: string;
  url: string;
  protocolVersion: string;
  capabilities: { streaming: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aSkill[];
  provider: { organization: string; url: string };
}

/**
 * Build the A2A AgentCard as a plain object. Every field is derived from the manifest:
 *   • `name`/`version`            ← serverName/serverVersion
 *   • `url`                       ← the agent's A2A JSON-RPC endpoint (`<baseUrl>/a2a`)
 *   • `protocolVersion`           ← the fixed {@link A2A_PROTOCOL_VERSION} constant
 *   • `skills[]`                  ← one per generated tool (id = tool.name)
 *   • `provider`                  ← the generator's identity (constant, not API-derived)
 * No value is invented from outside the manifest.
 */
export function buildAgentCard(inputs: A2aCardInputs): A2aAgentCard {
  const toolCount = inputs.tools.length;
  return {
    name: inputs.serverName,
    description:
      `A2A agent wrapping the ${inputs.serverName} MCP server ` +
      `(${toolCount} tool${toolCount === 1 ? '' : 's'}).`,
    version: inputs.serverVersion,
    // The A2A JSON-RPC endpoint this card describes. Derived from the API base URL;
    // operators override it via the A2A_PUBLIC_URL env var at runtime (see module).
    url: a2aEndpointUrl(inputs.baseUrl),
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: { streaming: true },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: inputs.tools.map((t) => ({
      id: t.name,
      name: t.title || t.name,
      description: t.description ?? '',
      tags: [],
    })),
    provider: { organization: 'mcpmake', url: 'https://github.com/starkyru/mcpmake-cli' },
  };
}

/** Derive the A2A JSON-RPC endpoint URL from the API base URL (`<base>/a2a`). */
function a2aEndpointUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/a2a`;
}

/** The AgentCard as pretty (2-space) JSON — stable key order, deterministic. */
export function agentCardJson(inputs: A2aCardInputs): string {
  return JSON.stringify(buildAgentCard(inputs), null, 2);
}

/**
 * Generate the `src/a2a.ts` module the server ships when A2A output is enabled.
 *
 * The AgentCard is embedded as a JSON-encoded string constant (so any character in a
 * tool description is inert in the generated source). `registerA2a(server, registerTools)`
 * stands up an A2A JSON-RPC listener that:
 *   • GET  /.well-known/agent.json  → returns the AgentCard.
 *   • POST /a2a (JSON-RPC 2.0):
 *       - `message/send`  → extracts the tool name + arguments from the A2A Message and
 *                           dispatches an MCP `tools/call` to the wrapped server, returning
 *                           the result as an A2A Message (text part) / completed Task.
 *       - `tasks/get`     → returns the stored Task for a prior `message/send` id.
 *
 * Tool dispatch uses an in-process loopback MCP client (`InMemoryTransport`) connected to
 * a dedicated McpServer that `registerTools` populates — public SDK API only, so it never
 * reaches into the primary transport's server or any SDK internals.
 */
export function buildA2aModule(inputs: A2aCardInputs): string {
  const card = buildAgentCard(inputs);
  // The full card, JSON-encoded into a single inert string constant.
  const cardLiteral = JSON.stringify(JSON.stringify(card, null, 2));
  // The set of valid skill ids (= tool names) the wrapper will accept, JSON-encoded so
  // each name is inert; used to reject unknown tool requests before dispatch.
  const skillIdsLiteral = JSON.stringify(card.skills.map((s) => s.id));

  return `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import http from 'node:http';
import crypto from 'node:crypto';

/* The AgentCard, baked at generation time and served at the A2A well-known path.
 * Embedded as a JSON-encoded string so no source-API text can break out of source. */
const AGENT_CARD_JSON = ${cardLiteral};
const AGENT_CARD = JSON.parse(AGENT_CARD_JSON) as {
  url: string;
  skills: { id: string }[];
  [k: string]: unknown;
};
const A2A_AGENT_CARD_PATH = ${JSON.stringify(A2A_AGENT_CARD_PATH)};
const A2A_RPC_PATH = '/a2a';
const A2A_PROTOCOL_VERSION = ${JSON.stringify(A2A_PROTOCOL_VERSION)};
/* Valid skill ids = generated tool names. An A2A request naming anything else is
 * rejected before dispatch (never forwarded to the MCP server). */
const SKILL_IDS = new Set<string>(${skillIdsLiteral});

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

/* A2A Task store: message/send may answer with a Task that the client later polls via
 * tasks/get. Kept in-memory and bounded — A2A is a stateless wrapper over MCP tools. */
interface A2aTask {
  id: string;
  contextId: string;
  status: { state: 'completed' | 'failed'; timestamp: string };
  artifacts: { artifactId: string; parts: { kind: 'text'; text: string }[] }[];
}
const A2A_MAX_TASKS = 1000;
const tasks = new Map<string, A2aTask>();

function rememberTask(task: A2aTask): void {
  // Bound the store: drop the oldest entry once at capacity (insertion order).
  if (tasks.size >= A2A_MAX_TASKS) {
    const oldest = tasks.keys().next().value;
    if (oldest !== undefined) tasks.delete(oldest);
  }
  tasks.set(task.id, task);
}

/* Extract a tool name + JSON arguments from an inbound A2A Message. The skill (tool)
 * name comes from message.metadata.skillId; arguments come from a single DataPart
 * (kind:'data') or a JSON-encoded TextPart. Returns null when the message is malformed
 * or names an unknown skill — the caller maps that to a JSON-RPC error. */
function extractToolCall(
  message: unknown,
): { name: string; args: Record<string, unknown> } | null {
  if (!message || typeof message !== 'object') return null;
  const meta = (message as { metadata?: unknown }).metadata;
  const skillId =
    meta && typeof meta === 'object'
      ? (meta as { skillId?: unknown }).skillId
      : undefined;
  if (typeof skillId !== 'string' || !SKILL_IDS.has(skillId)) return null;

  const parts = (message as { parts?: unknown }).parts;
  let args: Record<string, unknown> = {};
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const kind = (part as { kind?: unknown }).kind;
      if (kind === 'data') {
        const data = (part as { data?: unknown }).data;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          args = data as Record<string, unknown>;
        }
      } else if (kind === 'text') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            // A non-JSON text part is treated as having no structured args.
          }
        }
      }
    }
  }
  return { name: skillId, args };
}

/* Flatten an MCP CallToolResult's content blocks to a single text string for the A2A
 * Message/artifact. Text blocks are concatenated; non-text blocks are JSON-encoded. */
function resultToText(result: ToolResult): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        return String((block as { text?: unknown }).text ?? '');
      }
      return JSON.stringify(block);
    })
    .join('\\n');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

const MAX_BODY = 4 * 1024 * 1024; // 4 MB — same cap the MCP HTTP server uses.
function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (v: Buffer | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) {
        done(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', () => done(null));
    req.on('aborted', () => done(null));
  });
}

/**
 * Stand up the A2A wrapper. \`registerTools\` populates a DEDICATED McpServer (the same
 * registrar the primary server uses), which an in-process MCP client drives — so A2A
 * dispatch never contends with the primary transport. Returns the listening http.Server
 * (when A2A_HTTP=true) or undefined; callers can ignore the return value.
 */
export async function registerA2a(
  _server: McpServer,
  registerTools: (s: McpServer) => void,
): Promise<http.Server | undefined> {
  // Dedicated MCP server + loopback client for A2A → tools/call dispatch.
  const a2aMcpServer = new McpServer({ name: 'a2a-bridge', version: A2A_PROTOCOL_VERSION });
  registerTools(a2aMcpServer);
  const client = new Client({ name: 'a2a-bridge-client', version: A2A_PROTOCOL_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await a2aMcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  async function handleMessageSend(id: unknown, params: unknown): Promise<Record<string, unknown>> {
    const message = (params as { message?: unknown })?.message;
    const call = extractToolCall(message);
    if (!call) {
      return rpcError(id, -32602, 'Invalid A2A message: missing or unknown skillId (tool name)');
    }
    const result = await client.callTool({ name: call.name, arguments: call.args });
    const text = resultToText(result);
    const isError = (result as { isError?: unknown }).isError === true;
    const taskId = crypto.randomUUID();
    const contextId = crypto.randomUUID();
    const task: A2aTask = {
      id: taskId,
      contextId,
      status: {
        state: isError ? 'failed' : 'completed',
        // A2A Task timestamps are wall-clock; derived from the request, not baked.
        timestamp: new Date().toISOString(),
      },
      artifacts: [
        { artifactId: crypto.randomUUID(), parts: [{ kind: 'text', text }] },
      ],
    };
    rememberTask(task);
    return rpcResult(id, task);
  }

  function handleTasksGet(id: unknown, params: unknown): Record<string, unknown> {
    const taskId = (params as { id?: unknown })?.id;
    if (typeof taskId !== 'string') {
      return rpcError(id, -32602, 'Invalid tasks/get params: "id" is required');
    }
    const task = tasks.get(taskId);
    if (!task) return rpcError(id, -32001, 'Task not found');
    return rpcResult(id, task);
  }

  async function handleRpc(body: unknown): Promise<Record<string, unknown>> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return rpcError(null, -32600, 'Invalid Request');
    }
    const id = (body as { id?: unknown }).id;
    const method = (body as { method?: unknown }).method;
    const params = (body as { params?: unknown }).params;
    switch (method) {
      case 'message/send':
        return handleMessageSend(id, params);
      case 'tasks/get':
        return handleTasksGet(id, params);
      default:
        return rpcError(id, -32601, 'Method not found');
    }
  }

  // The A2A HTTP listener is opt-in (A2A_HTTP=true) so enabling --a2a never changes a
  // stdio server's runtime footprint unless the operator wants the A2A endpoint.
  if (process.env.A2A_HTTP !== 'true') return undefined;

  const port = parseInt(process.env.A2A_PORT ?? '3001', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid A2A_PORT value, must be 1-65535');
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', \`http://localhost:\${port}\`);
      const method = req.method ?? 'GET';

      if (url.pathname === A2A_AGENT_CARD_PATH && method === 'GET') {
        // The agent's own endpoint may be pinned at runtime without rebuilding.
        const publicUrl = process.env.A2A_PUBLIC_URL;
        const card = publicUrl ? { ...AGENT_CARD, url: publicUrl } : AGENT_CARD;
        sendJson(res, 200, card);
        return;
      }

      if (url.pathname === A2A_RPC_PATH && method === 'POST') {
        const raw = await readBody(req);
        if (raw === null) {
          sendJson(res, 200, rpcError(null, -32600, 'Request body too large'));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf-8'));
        } catch {
          sendJson(res, 200, rpcError(null, -32700, 'Parse error'));
          return;
        }
        sendJson(res, 200, await handleRpc(parsed));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch {
      if (!res.headersSent) sendJson(res, 200, rpcError(null, -32603, 'Internal error'));
    }
  });

  httpServer.listen(port, () => {
    process.stderr.write(
      JSON.stringify({ msg: 'A2A wrapper listening', port, card: A2A_AGENT_CARD_PATH }) + '\\n',
    );
  });
  return httpServer;
}
`;
}
