/**
 * Reusable loopback fake of the mcpmake cloud backend for the E4 auth/deploy
 * e2e suite.
 *
 * The auth + deploy unit tests each spin up a bespoke inline `http.createServer`
 * (see `test/commands/login.test.ts`, `test/commands/deploy.test.ts`,
 * `test/auth/api-client.test.ts`). This helper generalises those into one
 * configurable, stateful server bound to `127.0.0.1:0` (ephemeral port). It is
 * net-free: tests point the spawned CLI at the returned `url` and assert on real
 * exit codes, real written files, and the requests the server *captured*.
 *
 * Endpoints (all under the `/api/cli` + `/api/servers` paths the commands use):
 *   - POST /api/cli/device/start  → device-flow start payload (user_code, uris,
 *     interval, expires_in). The interval defaults to 0 so the CLI's poll loop
 *     floors it to its 2 s minimum — keep a test's poll count tiny.
 *   - POST /api/cli/device/token  → poll result. Modes:
 *       'granted'        → after `pendingPolls` "authorization_pending" replies,
 *                          returns `{ access_token }`.
 *       'access_denied'  → `{ error: 'access_denied' }`.
 *       'expired_token'  → `{ error: 'expired_token' }`.
 *   - GET  /api/cli/whoami        → 200 `{ email, plan }` or 401 `{ error }`.
 *   - POST /api/cli/logout        → 200 `{}` or 500 (revoke success / failure).
 *   - POST /api/servers           → deploy. Modes: 'ok' (200 DeployResult),
 *     '4xx' (400 JSON `{ error }`), '5xx' (500 plaintext). The full request
 *     (method, url, headers, raw body) is CAPTURED for assertions.
 *
 * Every request to every endpoint is recorded in `captured` so a test can assert
 * the Authorization header, the multipart Content-Type, the body bytes, etc.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** One recorded request. `body` is the raw bytes exactly as received. */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type DeviceTokenMode = 'granted' | 'access_denied' | 'expired_token';
export type WhoamiMode = 200 | 401;
export type LogoutMode = 200 | 500;
export type DeployMode = 'ok' | '4xx' | '5xx';

export interface FakeCloudConfig {
  /** Device-flow start payload. Sensible defaults provided per-field below. */
  deviceStart?: {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };
  /** Device-flow /token behaviour. Default 'granted' with 0 pending polls. */
  deviceToken?: DeviceTokenMode;
  /** How many "authorization_pending" replies precede a grant (mode 'granted'). */
  pendingPolls?: number;
  /** The token handed back by a granted device flow. */
  accessToken?: string;
  /** whoami response: 200 (returns email/plan) or 401 (rejected). */
  whoami?: WhoamiMode;
  /** Account identity returned by a 200 whoami. */
  email?: string;
  plan?: string;
  /** logout revoke result: 200 (revoked) or 500 (server error). */
  logout?: LogoutMode;
  /** deploy POST /api/servers result. */
  deploy?: DeployMode;
  /** Issued bearer token echoed in a successful DeployResult. */
  deployBearerToken?: string;
  /** Error string returned in a 4xx deploy JSON body. */
  deployErrorMessage?: string;
}

export interface FakeCloud {
  /** Base URL, e.g. http://127.0.0.1:54321 — pass as --server / MCPMAKE_SERVER. */
  readonly url: string;
  /** Every request the server received, in arrival order. */
  readonly captured: CapturedRequest[];
  /** Requests whose path starts with `prefix` (e.g. '/api/servers'). */
  capturedFor(prefix: string): CapturedRequest[];
  /** Mutate config between requests (rarely needed; most tests set it up front). */
  configure(patch: Partial<FakeCloudConfig>): void;
  /** Number of /api/cli/device/token polls observed so far. */
  tokenPolls(): number;
  stop(): Promise<void>;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Start the fake cloud on an ephemeral loopback port. Resolves once it is
 * listening; the caller MUST `await fc.stop()` in a `finally`.
 */
export async function startFakeCloud(initial: FakeCloudConfig = {}): Promise<FakeCloud> {
  const cfg: FakeCloudConfig = { ...initial };
  const captured: CapturedRequest[] = [];
  let tokenPolls = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      route(req, res);
    });
  });

  function route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';

    if (url.startsWith('/api/cli/device/start')) {
      const d = cfg.deviceStart ?? {};
      jsonResponse(res, 200, {
        device_code: d.device_code ?? 'dev_code_e4',
        user_code: d.user_code ?? 'WXYZ-1234',
        verification_uri: d.verification_uri ?? 'http://127.0.0.1:1/device',
        // verification_uri_complete points at a closed loopback port by default
        // so the (currently broken — see login.e2e.test.ts BUG note) browser
        // auto-open is a harmless no-op rather than launching a real browser.
        verification_uri_complete:
          d.verification_uri_complete ?? 'http://127.0.0.1:1/device?code=WXYZ-1234',
        interval: d.interval ?? 0,
        expires_in: d.expires_in ?? 600,
      });
      return;
    }

    if (url.startsWith('/api/cli/device/token')) {
      const n = tokenPolls++;
      const mode = cfg.deviceToken ?? 'granted';
      if (mode === 'access_denied') {
        jsonResponse(res, 200, { error: 'access_denied' });
        return;
      }
      if (mode === 'expired_token') {
        jsonResponse(res, 200, { error: 'expired_token' });
        return;
      }
      // granted
      if (n < (cfg.pendingPolls ?? 0)) {
        jsonResponse(res, 200, { error: 'authorization_pending' });
        return;
      }
      jsonResponse(res, 200, { access_token: cfg.accessToken ?? 'mfd_granted_e4_token' });
      return;
    }

    if (url.startsWith('/api/cli/whoami')) {
      if ((cfg.whoami ?? 200) === 401) {
        jsonResponse(res, 401, { error: 'invalid or expired token' });
        return;
      }
      jsonResponse(res, 200, {
        email: cfg.email ?? 'user@example.com',
        plan: cfg.plan ?? 'pro',
      });
      return;
    }

    if (url.startsWith('/api/cli/logout')) {
      if ((cfg.logout ?? 200) === 500) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('revoke failed');
        return;
      }
      jsonResponse(res, 200, {});
      return;
    }

    if (url.startsWith('/api/servers')) {
      const mode = cfg.deploy ?? 'ok';
      if (mode === '4xx') {
        jsonResponse(res, 400, {
          error: cfg.deployErrorMessage ?? 'spec was invalid: missing paths',
        });
        return;
      }
      if (mode === '5xx') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal boom');
        return;
      }
      const bearer = cfg.deployBearerToken ?? 'srv_issued_e4_token_5678';
      jsonResponse(res, 200, {
        slug: 'demo-slug',
        endpoint: 'https://demo-slug.mcpmake.dev/mcp',
        bearerToken: bearer,
        status: 'ok',
        toolCount: 3,
        claudeDesktopConfig: {
          mcpServers: {
            'demo-slug': {
              url: 'https://demo-slug.mcpmake.dev/mcp',
              headers: { Authorization: `Bearer ${bearer}` },
            },
          },
        },
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    capturedFor: (prefix: string) => captured.filter((r) => r.url.startsWith(prefix)),
    configure: (patch: Partial<FakeCloudConfig>) => Object.assign(cfg, patch),
    tokenPolls: () => tokenPolls,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
