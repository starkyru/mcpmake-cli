/**
 * Loopback OpenAI-compatible mock for the LLM-dependent e2e paths.
 *
 * The CLI's AI features (`from describe` spec generation, `from openapi
 * --improve-names`) reach an LLM through `@mcpmake/core`'s provider layer. To
 * exercise those paths end-to-end without a real key or network, we stand up a
 * tiny HTTP server on `127.0.0.1:0` that speaks just enough of the OpenAI wire
 * format the SDK calls:
 *
 *   GET  {baseURL}/models           — the model listing (`/v1/models`)
 *   POST {baseURL}/chat/completions — a chat completion (`/v1/chat/completions`)
 *
 * The OpenAI SDK appends those paths to the configured `baseURL`, so we hand the
 * test a base URL ending in `/v1` and route both `/v1/models` and
 * `/v1/chat/completions` (plus the un-prefixed variants, defensively).
 *
 * Wiring: `mockLlmEnv(mock)` returns the exact env a test must merge into
 * `runCli`'s `opts.env` to select this mock as the active provider:
 *   - MCPMAKE_LLM_PROVIDER=openai   (the hosted-OpenAI provider kind; chosen over
 *     `openai-compatible` so model resolution still works even if `/v1/models`
 *     were empty — but we serve it anyway)
 *   - OPENAI_BASE_URL=<mock>/v1     (points the SDK at the loopback stub)
 *   - OPENAI_API_KEY=<dummy>        (the `openai` kind requires a key to be set)
 *   - MCPMAKE_ALLOW_PRIVATE_HOSTS=1 (so core's SSRF guard admits 127.0.0.1)
 *
 * The mock is net-free and deterministic: every run binds a fresh ephemeral
 * port, serves canned responses the caller configures, and records each received
 * request for assertion.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One captured request the mock served, for post-hoc assertions. */
export interface RecordedRequest {
  /** HTTP method, e.g. `GET` / `POST`. */
  method: string;
  /** Request path, e.g. `/v1/chat/completions`. */
  path: string;
  /** Raw request body (empty string for GETs). */
  body: string;
  /** Parsed JSON body, or `undefined` when the body was empty/unparseable. */
  json?: unknown;
}

/** The full `chat.completions.create` response shape the SDK expects. */
function chatCompletion(content: string) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** The `/v1/models` listing shape (`{ object, data: [...] }`). */
function modelsList(ids: string[]) {
  return {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 1_700_000_000, owned_by: 'mock' })),
  };
}

export interface MockLlm {
  /** Base URL the test passes to the CLI, already ending in `/v1`. */
  readonly baseUrl: string;
  /**
   * Set the assistant `content` returned by the next (and every subsequent)
   * `POST /chat/completions`. For `from describe` this is a raw OpenAPI JSON
   * string (spec generation uses `completeText`); for `--improve-names` it is a
   * JSON object string matching the naming schema (`completeJson`).
   */
  setChatContent(content: string): void;
  /** Replace the model ids returned by `GET /models` (default: `['gpt-4o']`). */
  setModels(ids: string[]): void;
  /** Every request the mock has served so far, oldest first. */
  readonly requests: readonly RecordedRequest[];
  /** Requests to `chat/completions` only — the convenient common case. */
  chatRequests(): RecordedRequest[];
  /** Shut the server down and free the port. */
  close(): Promise<void>;
}

/**
 * Start the mock on `127.0.0.1` with an OS-assigned ephemeral port. Resolves
 * once it is listening. Always close it in a `finally`/`afterAll`.
 */
export async function startMockLlm(): Promise<MockLlm> {
  let chatContent = '{}';
  let modelIds = ['gpt-4o'];
  const requests: RecordedRequest[] = [];

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: unknown;
      if (body) {
        try {
          json = JSON.parse(body);
        } catch {
          json = undefined;
        }
      }
      const path = req.url ?? '';
      requests.push({ method: req.method ?? '', path, body, json });

      const send = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      };

      // Match on the path tail so both `/v1/models` and a bare `/models` work.
      if (req.method === 'GET' && path.endsWith('/models')) {
        send(200, modelsList(modelIds));
        return;
      }
      if (req.method === 'POST' && path.endsWith('/chat/completions')) {
        send(200, chatCompletion(chatContent));
        return;
      }
      send(404, { error: { message: `mock-llm: unhandled ${req.method} ${path}` } });
    });
  };

  const server: Server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 0 = ephemeral port; bind loopback only so nothing external can reach it.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  return {
    baseUrl,
    setChatContent(content: string) {
      chatContent = content;
    },
    setModels(ids: string[]) {
      modelIds = ids;
    },
    get requests() {
      return requests;
    },
    chatRequests() {
      return requests.filter((r) => r.path.endsWith('/chat/completions'));
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * The env a test must merge into `runCli`'s `opts.env` to route the CLI's LLM
 * calls at this mock. Mirrors `getLlmProvider` in
 * `packages/core/src/llm/index.ts`: the `openai` kind reads `OPENAI_API_KEY` +
 * `OPENAI_BASE_URL`, and the base-URL SSRF guard requires
 * `MCPMAKE_ALLOW_PRIVATE_HOSTS=1` to admit the loopback host.
 */
export function mockLlmEnv(mock: MockLlm): Record<string, string> {
  return {
    MCPMAKE_LLM_PROVIDER: 'openai',
    OPENAI_BASE_URL: mock.baseUrl,
    OPENAI_API_KEY: 'sk-mock-not-a-real-key',
    MCPMAKE_ALLOW_PRIVATE_HOSTS: '1',
  };
}
