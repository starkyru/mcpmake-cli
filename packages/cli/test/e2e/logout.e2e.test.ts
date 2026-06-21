/**
 * Sprint E4 — `mcpmake logout` end-to-end.
 *
 * The central contract: the local credentials file is deleted UNCONDITIONALLY
 * (success message differs, but a server revoke failure / unreachable server
 * must never strand the local token). Verified by asserting the file is gone on
 * disk after each branch.
 */

import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { startFakeCloud } from './helpers/fake-cloud.js';
import { E2E } from './helpers/gating.js';

function seedCreds(dir: string, creds: { serverUrl: string; token: string; email?: string }): void {
  const file = join(dir, 'credentials.json');
  writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

const credsPath = (dir: string): string => join(dir, 'credentials.json');

describe.skipIf(!E2E)('e2e logout: revoke + unconditional local cleanup', () => {
  beforeAll(() => ensureBuilt());

  it('with no credentials prints "Not logged in" and exits 0', async () => {
    await withTempDir(async (dir) => {
      const r = await runCli(['logout'], { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } });
      expect(r.code).toBe(0);
      expect(combined(r)).toContain('Not logged in.');
    });
  });

  it('a 200 revoke confirms the token was revoked and deletes the file', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ logout: 200 });
      try {
        seedCreds(dir, { serverUrl: fc.url, token: 'mfd_to_revoke_1' });
        const r = await runCli(['logout'], { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } });
        expect(r.code).toBe(0);
        expect(combined(r)).toContain('Logged out — the deploy token was revoked.');
        // The revoke actually hit the server with the stored bearer token.
        const reqs = fc.capturedFor('/api/cli/logout');
        expect(reqs).toHaveLength(1);
        expect(reqs[0].headers['authorization']).toBe('Bearer mfd_to_revoke_1');
        // File deleted.
        expect(existsSync(credsPath(dir))).toBe(false);
      } finally {
        await fc.stop();
      }
    });
  });

  it('a 500 revoke still cleans up locally and reports the local-only logout', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ logout: 500 });
      try {
        seedCreds(dir, { serverUrl: fc.url, token: 'mfd_revoke_fails_2' });
        const r = await runCli(['logout'], { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } });
        expect(r.code).toBe(0);
        expect(combined(r)).toContain('Logged out locally.');
        expect(combined(r)).toContain('Could not reach the server to revoke the token');
        // Server got the revoke attempt, returned 500, yet the file is gone.
        expect(fc.capturedFor('/api/cli/logout')).toHaveLength(1);
        expect(existsSync(credsPath(dir))).toBe(false);
      } finally {
        await fc.stop();
      }
    });
  });

  it('an unreachable server (closed port) still deletes the credentials file', async () => {
    await withTempDir(async (dir) => {
      // 127.0.0.1:1 is a privileged, almost-certainly-closed port → connection
      // refused, so the best-effort revoke fails before any byte is sent.
      seedCreds(dir, { serverUrl: 'http://127.0.0.1:1', token: 'mfd_unreachable_3' });
      const r = await runCli(['logout'], { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } });
      expect(r.code).toBe(0);
      expect(combined(r)).toContain('Logged out locally.');
      expect(existsSync(credsPath(dir))).toBe(false);
    });
  });
});
