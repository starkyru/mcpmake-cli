/**
 * Minimal JSON HTTP client for the CLI auth commands — node http/https only (no
 * fetch dependency, matching the deploy command's transport choice).
 */

import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export function apiRequest(
  method: string,
  baseUrl: string,
  path: string,
  opts: { token?: string; json?: unknown } = {},
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl);
    } catch {
      reject(new Error(`Invalid server URL: ${baseUrl}`));
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const payload = opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : undefined;
    const headers: Record<string, string | number> = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
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
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', (err) => reject(new Error(`Connection failed: ${err.message}`)));
    if (payload) req.write(payload);
    req.end();
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
