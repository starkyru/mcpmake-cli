/**
 * Recording mock upstream for the cross-language parity suite.
 *
 * One local node:http server stands in for the "Widget Store" API behind every
 * generated runtime (node stdio/http, worker, python). It answers a fixed route
 * table (so results are byte-comparable across languages) and records EVERY
 * request it receives — method, path, parsed query, the X-Api-Key auth header,
 * content type, and the parsed JSON body — so the tests can assert that all
 * four runtimes shape the upstream wire request identically. No real network
 * upstream is ever contacted; every generated server gets BASE_URL pinned here.
 */

import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedUpstreamRequest {
  method: string;
  /** Path only, no query string (query is parsed separately). */
  path: string;
  /** Parsed query parameters (single-valued; the fixture never repeats a key). */
  query: Record<string, string>;
  /** Value of the X-Api-Key header the spec's apiKey scheme must produce. */
  apiKey: string | undefined;
  contentType: string | undefined;
  /** Parsed JSON body, or null when absent/unparseable. */
  body: unknown;
}

export interface ParityUpstream {
  /** e.g. http://127.0.0.1:54321 — hand this to every runtime as BASE_URL. */
  baseUrl: string;
  /** Every request received since the last reset(), in arrival order. */
  requests: CapturedUpstreamRequest[];
  reset(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

/** Fixed route table — identical canned answers for every runtime. */
function route(method: string, path: string, body: unknown): { status: number; payload: unknown } {
  if (method === 'GET' && path === '/widgets') {
    return {
      status: 200,
      payload: [
        { id: 1, name: 'anvil' },
        { id: 2, name: 'rocket' },
      ],
    };
  }
  if (method === 'GET' && path === '/widgets/w-42') {
    return { status: 200, payload: { id: 'w-42', name: 'anvil', tags: ['a'] } };
  }
  if (method === 'GET' && path === '/widgets/missing') {
    return { status: 404, payload: { error: 'not found' } };
  }
  if (method === 'POST' && path === '/widgets') {
    return { status: 201, payload: { id: 'w-new', echo: body } };
  }
  if (method === 'DELETE' && path.startsWith('/widgets/')) {
    return { status: 200, payload: { deleted: true } };
  }
  return { status: 404, payload: { error: 'not found' } };
}

/** Start the recorder. Always `await upstream.close()` in `afterAll`. */
export async function startParityUpstream(): Promise<ParityUpstream> {
  const requests: CapturedUpstreamRequest[] = [];

  const server: Server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const url = new URL(req.url ?? '/', 'http://mock.invalid');
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
      }
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        query,
        apiKey: req.headers['x-api-key'] as string | undefined,
        contentType: req.headers['content-type'],
        body,
      });
      const { status, payload } = route(req.method ?? '', url.pathname, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    reset(): void {
      requests.length = 0;
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
