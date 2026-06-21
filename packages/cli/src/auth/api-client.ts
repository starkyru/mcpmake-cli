/**
 * Minimal JSON HTTP client for the CLI auth commands — node http/https only (no
 * fetch dependency, matching the deploy command's transport choice).
 *
 * Everything is funnelled through one bounded, HTTPS-aware low-level `request()`
 * so auth and deploy share the same channel policy (no plaintext token leaks)
 * and the same resource limits (request timeout + response-size cap).
 */

import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Default request/response deadline in ms. Overridable for tests. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default response-size cap (~1 MiB) for JSON responses. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** True for localhost / loopback hosts, where unencrypted dev traffic is acceptable. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/**
 * Validate a request URL's scheme. Only http(s) is ever spoken; anything else
 * (ftp:, file:, …) is rejected before a socket is opened. Throws on a bad scheme.
 */
export function assertHttpScheme(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${url.protocol}" — only http(s) is allowed.`);
  }
}

/**
 * Guard the credential channel for a request that carries a bearer token.
 * Allows HTTPS, and loopback hosts for local dev; refuses plaintext to a remote
 * host unless `insecure` (CLI flag) or MCPMAKE_INSECURE=1 is set. Throws on a
 * refusal — and NEVER includes the token in the message.
 */
export function assertSecureChannel(url: URL, insecure: boolean): void {
  assertHttpScheme(url);
  if (url.protocol === 'https:') return;
  if (isLoopbackHost(url.hostname)) return;
  if (insecure || process.env.MCPMAKE_INSECURE === '1') return;

  throw new Error(
    `Refusing to send credentials to ${url.origin} over an unencrypted (non-HTTPS) channel. ` +
      'Use an https:// URL, or pass --insecure (or set MCPMAKE_INSECURE=1) to override for trusted networks.',
  );
}

export interface RequestOptions {
  headers?: Record<string, string | number>;
  body?: Buffer;
  /** Bearer token. When set, the channel policy (assertSecureChannel) is enforced. */
  token?: string;
  /** Opt in to plaintext credential transport to a remote host. */
  insecure?: boolean;
  /** Response-size cap in bytes. Defaults to DEFAULT_MAX_RESPONSE_BYTES. */
  maxResponseBytes?: number;
  /** Request/response deadline in ms. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface RawResponse {
  status: number;
  text: string;
}

/**
 * Low-level bounded HTTP(S) request shared by `apiRequest` (JSON) and the deploy
 * command's multipart upload. Enforces:
 *   - scheme validation (http/https only) and the credential-channel policy;
 *   - a hard request/response timeout (destroys the socket on expiry);
 *   - a response-size cap, both via Content-Length and a streaming byte counter,
 *     so a chunked response with a missing/lying Content-Length can't exhaust
 *     memory.
 * Always tears down the socket and clears the timer on the error/timeout path.
 */
export function request(method: string, url: URL, opts: RequestOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    // Scheme + channel guards run before any socket is opened. When a token is
    // present we enforce the full secure-channel policy; otherwise we still
    // reject non-http(s) schemes.
    try {
      if (opts.token) assertSecureChannel(url, opts.insecure ?? false);
      else assertHttpScheme(url);
    } catch (err) {
      reject(err);
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const headers: Record<string, string | number> = { ...(opts.headers ?? {}) };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        // Reject early when the advertised size already blows the cap.
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          finish(() =>
            reject(new Error(`Response too large (${declared} bytes; cap ${maxBytes}).`)),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (c: Buffer) => {
          received += c.length;
          // Enforce the cap while streaming so a lying/absent Content-Length
          // cannot exhaust memory.
          if (received > maxBytes) {
            res.destroy();
            req.destroy();
            finish(() =>
              reject(new Error(`Response too large (exceeded cap of ${maxBytes} bytes).`)),
            );
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          finish(() =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          );
        });
        res.on('error', (err) => {
          finish(() => reject(new Error(`Connection failed: ${err.message}`)));
        });
      },
    );

    // Socket/request deadline: destroy the in-flight request and reject.
    timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error(`Request timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);
    // Belt-and-braces: also wire node's own socket timeout.
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(() => reject(new Error(`Request timed out after ${timeoutMs}ms.`)));
    });

    req.on('error', (err) => {
      finish(() => reject(new Error(`Connection failed: ${err.message}`)));
    });

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export function apiRequest(
  method: string,
  baseUrl: string,
  path: string,
  opts: {
    token?: string;
    json?: unknown;
    insecure?: boolean;
    maxResponseBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<ApiResponse> {
  let url: URL;
  try {
    url = new URL(path, baseUrl);
  } catch {
    return Promise.reject(new Error(`Invalid server URL: ${baseUrl}`));
  }

  const payload = opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : undefined;
  const headers: Record<string, string | number> = { Accept: 'application/json' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }

  return request(method, url, {
    headers,
    body: payload,
    token: opts.token,
    insecure: opts.insecure,
    maxResponseBytes: opts.maxResponseBytes,
    timeoutMs: opts.timeoutMs,
  }).then(({ status, text }) => {
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        const parsed = JSON.parse(text);
        body =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : { value: parsed };
      } catch {
        body = { _raw: text };
      }
    }
    return { status, body };
  });
}

/** Best-effort: open `url` in the user's default browser. Never throws. */
export function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // best effort — the user can open the URL manually
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
