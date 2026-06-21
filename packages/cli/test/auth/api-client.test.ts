import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  apiRequest,
  request,
  assertSecureChannel,
  assertHttpScheme,
  isLoopbackHost,
} from '../../src/auth/api-client.js';

const TOKEN = 'mfd_probe_secret_abcd1234';

/**
 * Spin up a loopback backend. `handler` controls the response so individual
 * tests can simulate oversized bodies, hangs, etc. Records every observed
 * Authorization header so we can assert the token never crossed the wire.
 */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; authHeaders: (string | undefined)[]; close: () => Promise<void> }> {
  const authHeaders: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    authHeaders.push(req.headers['authorization']);
    handler(req, res);
  });
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveListen({
        port,
        authHeaders,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const ORIG_INSECURE = process.env.MCPMAKE_INSECURE;
afterEach(() => {
  if (ORIG_INSECURE === undefined) delete process.env.MCPMAKE_INSECURE;
  else process.env.MCPMAKE_INSECURE = ORIG_INSECURE;
});

describe('isLoopbackHost', () => {
  it('recognises loopback hosts and rejects remote ones', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('app.localhost')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('169.254.1.1')).toBe(false);
  });
});

describe('assertHttpScheme', () => {
  it('rejects non-http(s) schemes', () => {
    expect(() => assertHttpScheme(new URL('ftp://host/'))).toThrow(/scheme/i);
    expect(() => assertHttpScheme(new URL('file:///etc/passwd'))).toThrow(/scheme/i);
  });
  it('accepts http and https', () => {
    expect(() => assertHttpScheme(new URL('http://localhost/'))).not.toThrow();
    expect(() => assertHttpScheme(new URL('https://example.com/'))).not.toThrow();
  });
});

describe('assertSecureChannel', () => {
  beforeEach(() => {
    delete process.env.MCPMAKE_INSECURE;
  });

  it('allows https to any host', () => {
    expect(() => assertSecureChannel(new URL('https://example.com/'), false)).not.toThrow();
  });

  it('allows plaintext to loopback hosts (dev)', () => {
    expect(() => assertSecureChannel(new URL('http://localhost:3001/'), false)).not.toThrow();
    expect(() => assertSecureChannel(new URL('http://127.0.0.1:3001/'), false)).not.toThrow();
  });

  it('refuses plaintext to a remote host without opt-in, and never leaks the token', () => {
    let thrown: Error | undefined;
    try {
      assertSecureChannel(new URL('http://example.com/'), false);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toMatch(/unencrypted/i);
    // The helper has no access to the token, but assert the contract anyway.
    expect(thrown!.message).not.toContain(TOKEN);
  });

  it('allows plaintext remote with the insecure flag', () => {
    expect(() => assertSecureChannel(new URL('http://example.com/'), true)).not.toThrow();
  });

  it('allows plaintext remote with MCPMAKE_INSECURE=1', () => {
    process.env.MCPMAKE_INSECURE = '1';
    expect(() => assertSecureChannel(new URL('http://example.com/'), false)).not.toThrow();
  });

  it('rejects non-http(s) schemes even with a would-be token', () => {
    expect(() => assertSecureChannel(new URL('ftp://example.com/'), true)).toThrow(/scheme/i);
  });
});

describe('apiRequest channel policy', () => {
  beforeEach(() => {
    delete process.env.MCPMAKE_INSECURE;
  });

  it('does NOT send a token over plaintext to a remote host without opt-in', async () => {
    // Bind the server to loopback but address it via a non-loopback hostname so
    // isLoopbackHost() is false and the channel guard fires. The request must be
    // refused before any byte (and certainly the Authorization header) is sent.
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    try {
      await expect(
        apiRequest('GET', `http://example.com:${srv.port}`, '/whoami', { token: TOKEN }),
      ).rejects.toThrow(/unencrypted/i);
      // Server never received a request carrying the token.
      expect(srv.authHeaders).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it('rejects a non-http(s) scheme outright', async () => {
    await expect(apiRequest('GET', 'ftp://host/', '/', { token: TOKEN })).rejects.toThrow(
      /scheme/i,
    );
  });

  it('allows a token over plaintext loopback (local dev) and sends it', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: 'a@b.c' }));
    });
    try {
      const res = await apiRequest('GET', `http://127.0.0.1:${srv.port}`, '/whoami', {
        token: TOKEN,
      });
      expect(res.status).toBe(200);
      expect(res.body.email).toBe('a@b.c');
      expect(srv.authHeaders).toContain(`Bearer ${TOKEN}`);
    } finally {
      await srv.close();
    }
  });

  it('allows a token over plaintext remote with insecure: true (guard does not refuse)', async () => {
    // A real remote hostname would actually resolve, so instead of completing a
    // round-trip we prove the channel guard let the request through to the
    // transport: it fails with a timeout/connection error, NOT an /unencrypted/
    // refusal. The opt-in therefore bypassed the plaintext guard.
    const err = await apiRequest('GET', 'http://198.51.100.7:9', '/whoami', {
      token: TOKEN,
      insecure: true,
      timeoutMs: 150,
    }).then(
      () => null,
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/unencrypted/i);
    expect(err!.message).not.toContain(TOKEN);
  });

  it('allows a token over plaintext remote with MCPMAKE_INSECURE=1 (guard does not refuse)', async () => {
    process.env.MCPMAKE_INSECURE = '1';
    const err = await apiRequest('GET', 'http://198.51.100.7:9', '/whoami', {
      token: TOKEN,
      timeoutMs: 150,
    }).then(
      () => null,
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/unencrypted/i);
    expect(err!.message).not.toContain(TOKEN);
  });
});

describe('apiRequest resource limits', () => {
  it('rejects a response that exceeds the size cap (streamed, no Content-Length)', async () => {
    const srv = await startServer((_req, res) => {
      // Chunked (no Content-Length) so only the streaming byte counter can catch it.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 0x61); // 64 KiB of 'a'
      let sent = 0;
      const pump = (): void => {
        // Push ~2 MiB, well over the 1 MiB cap.
        if (sent >= 2 * 1024 * 1024) {
          res.end();
          return;
        }
        sent += chunk.length;
        if (res.write(chunk)) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    });
    try {
      await expect(
        apiRequest('GET', `http://127.0.0.1:${srv.port}`, '/big', {
          maxResponseBytes: 1024 * 1024,
        }),
      ).rejects.toThrow(/too large/i);
    } finally {
      await srv.close();
    }
  });

  it('rejects early when Content-Length advertises an oversized body', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(5 * 1024 * 1024),
      });
      res.end(Buffer.alloc(1024)); // we never read enough to matter; CL check fires first
    });
    try {
      await expect(
        apiRequest('GET', `http://127.0.0.1:${srv.port}`, '/big', {
          maxResponseBytes: 1024 * 1024,
        }),
      ).rejects.toThrow(/too large/i);
    } finally {
      await srv.close();
    }
  });

  it('times out when the server never responds', async () => {
    // Server accepts the connection but never writes a response.
    const srv = await startServer(() => {
      /* hang forever */
    });
    try {
      await expect(
        apiRequest('GET', `http://127.0.0.1:${srv.port}`, '/hang', { timeoutMs: 150 }),
      ).rejects.toThrow(/timed out/i);
    } finally {
      await srv.close();
    }
  });
});

describe('low-level request()', () => {
  it('enforces the channel policy for a bare token request', async () => {
    await expect(request('GET', new URL('http://example.com/'), { token: TOKEN })).rejects.toThrow(
      /unencrypted/i,
    );
  });

  it('allows a tokenless request over any http(s) scheme', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    try {
      const res = await request('GET', new URL(`http://127.0.0.1:${srv.port}/ping`));
      expect(res.status).toBe(200);
      expect(res.text).toBe('ok');
    } finally {
      await srv.close();
    }
  });
});
