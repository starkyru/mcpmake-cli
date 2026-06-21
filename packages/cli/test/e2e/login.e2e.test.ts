/**
 * Sprint E4 — `mcpmake login` end-to-end.
 *
 * Spawns the built bin against a loopback fake cloud (helpers/fake-cloud.ts) and
 * asserts the real credentials.json that lands in MCPMAKE_CONFIG_DIR (which the
 * harness points at the sandbox cwd), including its 0600 permission bits.
 *
 * No in-process mocking: the only boundary faked is the HTTP backend. Every
 * exit code, message substring, and file is the real CLI's output.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { startFakeCloud } from './helpers/fake-cloud.js';
import { E2E } from './helpers/gating.js';

interface OnDiskCreds {
  serverUrl: string;
  token: string;
  email?: string;
}

function readCreds(dir: string): OnDiskCreds {
  return JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')) as OnDiskCreds;
}

describe.skipIf(!E2E)('e2e login: device flow + token paste', () => {
  beforeAll(() => ensureBuilt());

  it('device flow pending→granted writes 0600 credentials.json with the right fields', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({
        deviceToken: 'granted',
        pendingPolls: 1, // one authorization_pending poll, then a grant
        accessToken: 'mfd_device_granted_777',
        email: 'dev@example.com',
        plan: 'pro',
        deviceStart: { interval: 0, expires_in: 600 }, // interval 0 → floored to 2s poll
      });
      try {
        const r = await runCli(['login', '--server', fc.url, '--no-browser'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
          timeoutMs: 30_000,
        });
        expect(r.code).toBe(0);

        const out = combined(r);
        // The user-facing device prompt: the user_code and verification_uri the
        // fake cloud returned are echoed verbatim.
        expect(out).toContain('WXYZ-1234');
        expect(out).toContain('http://127.0.0.1:1/device');
        expect(out).toContain('Logged in as dev@example.com');

        // A real credentials file landed in the sandbox config dir...
        const creds = readCreds(dir);
        expect(creds).toEqual({
          serverUrl: fc.url,
          token: 'mfd_device_granted_777',
          email: 'dev@example.com',
        });

        // ...with owner-only 0600 perms (the security contract this command owns).
        const mode = statSync(join(dir, 'credentials.json')).mode & 0o777;
        expect(mode).toBe(0o600);

        // The poll loop actually polled past the pending reply before granting.
        expect(fc.tokenPolls()).toBeGreaterThanOrEqual(2);

        // `--no-browser` correctly suppresses the auto-open: citty/mri sets
        // args.browser=false, the command gates on that, so openBrowser is never
        // called and the "Opening your browser…" line is absent.
        expect(out).not.toContain('Opening your browser…');
      } finally {
        await fc.stop();
      }
    });
  });

  it('device flow access_denied fails with exit 1 and writes no credentials', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ deviceToken: 'access_denied' });
      try {
        const r = await runCli(['login', '--server', fc.url, '--no-browser'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
          timeoutMs: 30_000,
        });
        expect(r.code).toBe(1);
        expect(combined(r)).toContain('Login was denied in the browser.');
        // Denied login must not leave a credentials file behind.
        expect(() => readCreds(dir)).toThrow();
      } finally {
        await fc.stop();
      }
    });
  });

  it('device flow expired_token fails with exit 1 and the "code expired" message', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ deviceToken: 'expired_token' });
      try {
        const r = await runCli(['login', '--server', fc.url, '--no-browser'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
          timeoutMs: 30_000,
        });
        expect(r.code).toBe(1);
        expect(combined(r)).toContain('The login code expired. Run `mcpmake login` again.');
        expect(() => readCreds(dir)).toThrow();
      } finally {
        await fc.stop();
      }
    });
  });

  it('--token paste path: a 200-accepted mfd_ token is stored', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ whoami: 200, email: 'paste@example.com' });
      try {
        const r = await runCli(['login', '--server', fc.url, '--token', 'mfd_paste_ok_1234'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(0);
        expect(combined(r)).toContain('Logged in as paste@example.com');

        const creds = readCreds(dir);
        expect(creds).toEqual({
          serverUrl: fc.url,
          token: 'mfd_paste_ok_1234',
          email: 'paste@example.com',
        });
        const mode = statSync(join(dir, 'credentials.json')).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        await fc.stop();
      }
    });
  });

  it('--token paste path: a 401-rejected token fails with exit 1 and stores nothing', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ whoami: 401 });
      try {
        const r = await runCli(['login', '--server', fc.url, '--token', 'mfd_rejected_9999'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(1);
        expect(combined(r)).toContain('That deploy token was rejected by the server.');
        expect(() => readCreds(dir)).toThrow();
      } finally {
        await fc.stop();
      }
    });
  });

  it('--token paste path: a non-mfd_ token is rejected locally before any request', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ whoami: 200 });
      try {
        const r = await runCli(['login', '--server', fc.url, '--token', 'not_a_deploy_token'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(1);
        expect(combined(r)).toContain('A deploy token must start with "mfd_".');
        // Rejected client-side: the server never saw a whoami probe.
        expect(fc.capturedFor('/api/cli/whoami')).toHaveLength(0);
        expect(() => readCreds(dir)).toThrow();
      } finally {
        await fc.stop();
      }
    });
  });
});
