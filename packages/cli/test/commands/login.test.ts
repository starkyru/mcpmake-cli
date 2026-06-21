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
 * fields (including adversarial values like 1e309) and over how many /token polls
 * answer `authorization_pending` before a token is finally granted.
 *
 * `pendingPolls: Infinity` means /token never grants — forcing the poll loop to
 * terminate on the deadline, which is exactly how the expires_in clamp is
 * observed end-to-end.
 */
async function startFakeServerRaw(opts: {
  startBody: Record<string, unknown>;
  /** How many /token calls answer authorization_pending before a token. Default 0. */
  pendingPolls?: number;
}): Promise<{ url: string; close: () => Promise<void>; tokenPolls: () => number }> {
  let tokenPolls = 0;
  const pending = opts.pendingPolls ?? 0;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/cli/device/start')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.startBody));
      return;
    }
    if (req.url?.startsWith('/api/cli/device/token')) {
      const n = tokenPolls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (n < pending) {
        res.end(JSON.stringify({ error: 'authorization_pending' }));
      } else {
        res.end(JSON.stringify({ access_token: 'tok_test_abc' }));
      }
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
    tokenPolls: () => tokenPolls,
  };
}

describe('login command — expires_in / interval DoS guard (R3-1)', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    spies.length = 0;
  });

  /**
   * Run the real login command against `serverUrl` with a *virtual clock* driving
   * the poll loop. The only timing boundaries the command touches are
   * `apiClient.sleep` (line 125) and `Date.now()` (lines 92 & 124); we mock both:
   *
   *   - `sleep(ms)` resolves instantly AND advances the virtual clock by `ms`, so
   *     the deadline `Date.now() + expiresIn*1000` is reached in zero real time.
   *   - every captured `sleep(ms)` is recorded in `sleeps`, so a test can assert
   *     the *actual* clamped poll interval independently of the source's math.
   *
   * Crucially, if the expires_in clamp at login.ts:88-91 were removed and the
   * deadline became Infinity, the virtual clock would never reach it and the loop
   * would never terminate — surfacing as a real vitest timeout, not a silent pass.
   *
   * `process.exit` is converted to a throw (repo convention) so the deadline /
   * timeout path is observable instead of killing the test runner.
   */
  async function runLoginVirtualClock(serverUrl: string): Promise<{
    sleeps: number[];
    infos: string[];
    errors: string[];
    saved: boolean;
    threw: unknown;
  }> {
    const sleeps: number[] = [];
    const infos: string[] = [];
    const errors: string[] = [];
    let saved = false;

    // Virtual clock: starts at the real now, advanced only by sleep().
    let virtualNow = Date.now();
    spies.push(vi.spyOn(Date, 'now').mockImplementation(() => virtualNow));
    spies.push(
      vi.spyOn(apiClient, 'sleep').mockImplementation((ms: number) => {
        sleeps.push(ms);
        virtualNow += ms; // advance the virtual clock toward the deadline
        return Promise.resolve();
      }),
    );

    spies.push(
      vi.spyOn(logger, 'info').mockImplementation((...a: unknown[]) => {
        infos.push(a.map(String).join(' '));
      }),
      vi.spyOn(logger, 'success').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation((...a: unknown[]) => {
        errors.push(a.map(String).join(' '));
      }),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(apiClient, 'openBrowser').mockImplementation(() => {}),
      vi.spyOn(credentials, 'saveCredentials').mockImplementation(async () => {
        saved = true;
      }),
      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as never),
    );

    const loginCommand = (await import('../../src/commands/login.js')).default;
    let threw: unknown;
    try {
      await loginCommand.run!({
        args: { server: serverUrl, token: undefined, 'no-browser': true, insecure: false },
        rawArgs: [],
      } as never);
    } catch (e) {
      threw = e;
    }
    return { sleeps, infos, errors, saved, threw };
  }

  it('clamps a finite-but-huge interval to 60 s before sleeping (interval upper clamp)', async () => {
    // interval:999999 is finite, so it survives the Number.isFinite guard and hits
    // the Math.min(..., 60) clamp. Independently hand-computed expectation: 60 s.
    const EXPECTED_POLL_MS = 60 * 1000;
    const backend = await startFakeServerRaw({
      startBody: {
        device_code: 'dc',
        user_code: 'UC-1',
        verification_uri: 'https://mcpmake.dev/device',
        verification_uri_complete: 'https://mcpmake.dev/device',
        interval: 999999, // finite & huge — must be clamped to 60 s, not honored
        expires_in: 600,
      },
      pendingPolls: 1, // one pending poll forces at least one sleep we can inspect
    });
    try {
      const { sleeps, saved, threw } = await runLoginVirtualClock(backend.url);
      expect(threw).toBeUndefined();
      expect(saved).toBe(true); // happy path completed
      // The poll loop slept with the *clamped* interval, not 999999*1000 ms.
      expect(sleeps.length).toBeGreaterThan(0);
      expect(sleeps.every((ms) => ms === EXPECTED_POLL_MS)).toBe(true);
      expect(sleeps).not.toContain(999999 * 1000);
    } finally {
      await backend.close();
    }
  });

  it('floors a positive sub-2 interval (interval:1) to the 2 s minimum', async () => {
    const EXPECTED_POLL_MS = 2 * 1000; // Math.max(2, 1) * 1000
    const backend = await startFakeServerRaw({
      startBody: {
        device_code: 'dc',
        user_code: 'UC-2b',
        verification_uri: 'https://mcpmake.dev/device',
        verification_uri_complete: 'https://mcpmake.dev/device',
        interval: 1, // positive but below the floor → must become 2 s
        expires_in: 600,
      },
      pendingPolls: 2,
    });
    try {
      const { sleeps, saved, threw } = await runLoginVirtualClock(backend.url);
      expect(threw).toBeUndefined();
      expect(saved).toBe(true);
      expect(sleeps.length).toBeGreaterThan(0);
      expect(sleeps.every((ms) => ms === EXPECTED_POLL_MS)).toBe(true);
      expect(sleeps).not.toContain(1 * 1000);
    } finally {
      await backend.close();
    }
  });

  it('clamps expires_in: 1e309 (Infinity) to a finite deadline so the poll loop terminates', async () => {
    // 1e309 → Infinity. The guard that neutralizes Infinity is the
    // `Number.isFinite(rawExpires) && rawExpires > 0 ? rawExpires : 600` fallback
    // at login.ts:88-90 (NOT the 3600 cap, which only matters for finite values —
    // see the 1e15 test below). Removing that fallback makes expiresIn = Infinity,
    // so deadline = Infinity and `Date.now() < deadline` is forever true.
    //
    // /token never grants (pendingPolls: Infinity), so the ONLY way the loop can
    // exit is the deadline. The virtual clock advances by the poll interval each
    // iteration, so a *finite* deadline is reached in a bounded number of steps;
    // if the fallback were deleted the virtual clock would never reach Infinity
    // and this test would hang (surfacing as a real vitest timeout).
    const POLL_MS = 5 * 1000; // interval:0 → fallback 5 s
    const EXPECTED_DEADLINE_S = 600; // Infinity → fallback 600, then min(600, 3600)
    const EXPECTED_ITERATIONS = Math.ceil((EXPECTED_DEADLINE_S * 1000) / POLL_MS); // 120
    const backend = await startFakeServerRaw({
      startBody: {
        device_code: 'dc',
        user_code: 'UC-3',
        verification_uri: 'https://mcpmake.dev/device',
        verification_uri_complete: 'https://mcpmake.dev/device',
        interval: 0, // → 5 s poll
        expires_in: 1e309, // Infinity after Number() — must be clamped
      },
      pendingPolls: Infinity,
    });
    try {
      const { sleeps, errors, saved, threw } = await runLoginVirtualClock(backend.url);
      // The loop terminated (did not hang) and hit the timeout-then-exit path.
      expect(threw).toBeInstanceOf(Error);
      expect((threw as Error).message).toBe('process.exit called');
      expect(errors.join('\n')).toMatch(/timed out/i);
      expect(saved).toBe(false); // no token was ever granted
      // Iteration count proves the deadline was finite (~600 s / 5 s), not Infinity.
      expect(sleeps.length).toBe(EXPECTED_ITERATIONS);
      // It is the deadline, not the token poll count, that bounds the loop.
      expect(backend.tokenPolls()).toBe(EXPECTED_ITERATIONS);
    } finally {
      await backend.close();
    }
  });

  it('caps a far-future expires_in: 1e15 at 3600 s (deadline upper cap R4-B)', async () => {
    // 1e15 is finite, so it survives the isFinite guard and must be capped by
    // Math.min(..., 3600). Without the cap the deadline would be ~1e15 s in the
    // future and (with pending polls) the loop would run ~1e15/5 iterations.
    const POLL_MS = 5 * 1000; // interval:0 → 5 s
    const CAPPED_DEADLINE_S = 3600; // min(1e15, 3600)
    const EXPECTED_ITERATIONS = Math.ceil((CAPPED_DEADLINE_S * 1000) / POLL_MS); // 720
    const UNCAPPED_ITERATIONS = (1e15 * 1000) / POLL_MS; // astronomically larger
    const backend = await startFakeServerRaw({
      startBody: {
        device_code: 'dc',
        user_code: 'UC-4',
        verification_uri: 'https://mcpmake.dev/device',
        verification_uri_complete: 'https://mcpmake.dev/device',
        interval: 0, // → 5 s poll
        expires_in: 1e15, // far-future, finite — must be capped to 3600 s
      },
      pendingPolls: Infinity,
    });
    try {
      const { sleeps, errors, saved, threw } = await runLoginVirtualClock(backend.url);
      expect(threw).toBeInstanceOf(Error);
      expect((threw as Error).message).toBe('process.exit called');
      expect(errors.join('\n')).toMatch(/timed out/i);
      expect(saved).toBe(false);
      // Exactly the capped number of iterations — proves 3600 s won, not 1e15 s.
      expect(sleeps.length).toBe(EXPECTED_ITERATIONS);
      expect(sleeps.length).toBeLessThan(UNCAPPED_ITERATIONS);
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
