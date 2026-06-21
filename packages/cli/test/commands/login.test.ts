/**
 * Tests for login command security fixes.
 *
 * A4-9: openBrowser must only be called for http(s) URLs. A malicious
 * --server returning a file:// or javascript: URI in verification_uri_complete
 * must not trigger auto-open; the user is asked to open the printed URL manually.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as apiClient from '../../src/auth/api-client.js';
import * as credentials from '../../src/auth/credentials.js';
import { logger } from '@mcpmake/core';

/** Spin up a fake device-flow backend that returns the given URIs from /device/start. */
async function startFakeServer(opts: {
  verificationUri: string;
  verificationUriComplete: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/cli/device/start')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          device_code: 'dev_code_123',
          user_code: 'USER-1234',
          verification_uri: opts.verificationUri,
          verification_uri_complete: opts.verificationUriComplete,
          interval: 1,
          expires_in: 5,
        }),
      );
      return;
    }
    if (req.url?.startsWith('/api/cli/device/token')) {
      // Immediately return a token so the poll loop exits fast.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'tok_test_abc' }));
      return;
    }
    if (req.url?.startsWith('/api/cli/whoami')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: 'user@example.com' }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * Spin up a fake device-flow backend with full control over the start-response
 * fields, including adversarial values like 1e309.
 */
async function startFakeServerRaw(opts: {
  startBody: Record<string, unknown>;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/cli/device/start')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.startBody));
      return;
    }
    if (req.url?.startsWith('/api/cli/device/token')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'tok_test_abc' }));
      return;
    }
    if (req.url?.startsWith('/api/cli/whoami')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: 'user@example.com' }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('login command — expires_in / interval DoS guard (R3-1)', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    spies.length = 0;
  });

  async function runLoginRaw(serverUrl: string): Promise<void> {
    spies.push(
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'success').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(apiClient, 'openBrowser').mockImplementation(() => {}),
      vi.spyOn(credentials, 'saveCredentials').mockResolvedValue(undefined),
    );
    const loginCommand = (await import('../../src/commands/login.js')).default;
    await loginCommand.run!({
      args: { server: serverUrl, token: undefined, 'no-browser': true, insecure: false },
      rawArgs: [],
    } as never);
  }

  it('completes even when the server returns expires_in: 1e309 (Infinity guard)', async () => {
    // 1e309 parses to Infinity — the bug caused an infinite poll loop.
    // The /token endpoint returns a token immediately, so if the deadline is
    // finite (clamped to 600 s) the loop exits after the first poll.
    const backend = await startFakeServerRaw({
      startBody: {
        device_code: 'dc',
        user_code: 'UC-1',
        verification_uri: 'https://mcpmake.dev/device',
        verification_uri_complete: 'https://mcpmake.dev/device',
        interval: 1,
        expires_in: 1e309, // Infinity after Number()
      },
    });
    try {
      // Should resolve without hanging — if deadline were Infinity this would
      // never return and the test would time out.
      await runLoginRaw(backend.url);
    } finally {
      await backend.close();
    }
  });

  it('completes when the server returns interval: 1e309 (interval clamp guard)', async () => {
    // A rogue interval:Infinity would cause sleep(Infinity) — also an infinite hang.
    // The clamp to 60 s max + immediate token response lets it exit quickly.
    const backend = await startFakeServerRaw({
      startBody: {
        device_code: 'dc',
        user_code: 'UC-2',
        verification_uri: 'https://mcpmake.dev/device',
        verification_uri_complete: 'https://mcpmake.dev/device',
        interval: 1e309, // Infinity after Number()
        expires_in: 5,
      },
    });
    try {
      await runLoginRaw(backend.url);
    } finally {
      await backend.close();
    }
  });

  it('completes when the server returns expires_in: 1e15 (far-future upper cap R4-B)', async () => {
    // A malicious server returning a huge expires_in (e.g. 1e15) would keep the
    // deadline far in the future. Combined with slow_down the poll loop could stall
    // for an arbitrary time. The cap at 3600 s ensures the deadline is sane even
    // though the /token endpoint returns a token immediately in this test.
    const backend = await startFakeServerRaw({
      startBody: {
        device_code: 'dc',
        user_code: 'UC-3',
        verification_uri: 'https://mcpmake.dev/device',
        verification_uri_complete: 'https://mcpmake.dev/device',
        interval: 1,
        expires_in: 1e15, // far-future, finite — must be capped to 3600
      },
    });
    try {
      await runLoginRaw(backend.url);
    } finally {
      await backend.close();
    }
  });
});

describe('login command browser URL scheme guard (A4-9)', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    spies.length = 0;
  });

  async function runLogin(
    serverUrl: string,
  ): Promise<{ openBrowserCalled: boolean; infos: string[] }> {
    const infos: string[] = [];
    spies.push(
      vi.spyOn(logger, 'info').mockImplementation((...a: unknown[]) => {
        infos.push(a.join(' '));
      }),
      vi.spyOn(logger, 'success').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    );
    let openBrowserCalled = false;
    spies.push(
      vi.spyOn(apiClient, 'openBrowser').mockImplementation(() => {
        openBrowserCalled = true;
      }),
    );
    // saveCredentials — prevent fs writes during tests.
    spies.push(vi.spyOn(credentials, 'saveCredentials').mockResolvedValue(undefined));

    const loginCommand = (await import('../../src/commands/login.js')).default;
    await loginCommand.run!({
      args: {
        server: serverUrl,
        token: undefined,
        'no-browser': false,
        insecure: false,
      },
      rawArgs: [],
    } as never);

    return { openBrowserCalled, infos };
  }

  it('calls openBrowser when verification_uri_complete is an https URL', async () => {
    const backend = await startFakeServer({
      verificationUri: 'https://mcpmake.dev/device',
      verificationUriComplete: 'https://mcpmake.dev/device?code=USER-1234',
    });
    try {
      const { openBrowserCalled } = await runLogin(backend.url);
      expect(openBrowserCalled).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it('calls openBrowser when verification_uri_complete is an http URL', async () => {
    const backend = await startFakeServer({
      verificationUri: 'http://localhost:4000/device',
      verificationUriComplete: 'http://localhost:4000/device?code=USER-1234',
    });
    try {
      const { openBrowserCalled } = await runLogin(backend.url);
      expect(openBrowserCalled).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it('skips openBrowser and logs a warning when verification_uri_complete has a file:// scheme', async () => {
    const backend = await startFakeServer({
      verificationUri: 'https://mcpmake.dev/device',
      // Malicious: a compromised --server could return a file:// URI
      verificationUriComplete: 'file:///etc/passwd',
    });
    try {
      const { openBrowserCalled, infos } = await runLogin(backend.url);
      expect(openBrowserCalled).toBe(false);
      expect(infos.join('\n')).toMatch(/auto-open|scheme|manually/i);
    } finally {
      await backend.close();
    }
  });

  it('skips openBrowser and logs a warning when verification_uri_complete is not a valid URL', async () => {
    const backend = await startFakeServer({
      verificationUri: 'https://mcpmake.dev/device',
      verificationUriComplete: 'not-a-url-at-all',
    });
    try {
      const { openBrowserCalled, infos } = await runLogin(backend.url);
      expect(openBrowserCalled).toBe(false);
      expect(infos.join('\n')).toMatch(/auto-open|scheme|manually/i);
    } finally {
      await backend.close();
    }
  });
});
