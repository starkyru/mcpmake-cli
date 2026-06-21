/**
 * Sprint E4 — `mcpmake whoami` end-to-end.
 *
 * Covers the three identity states (no creds / 200 / 401), the security contract
 * that a rejected token is never echoed, and the deploy-token precedence
 * (MCPMAKE_DEPLOY_TOKEN env vs --token flag vs stored credentials).
 */

import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { startFakeCloud } from './helpers/fake-cloud.js';
import { E2E } from './helpers/gating.js';

/** Write a credentials.json into the sandbox config dir, 0600 like the real CLI. */
function seedCreds(dir: string, creds: { serverUrl: string; token: string; email?: string }): void {
  const file = join(dir, 'credentials.json');
  writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

describe.skipIf(!E2E)('e2e whoami: identity + token precedence', () => {
  beforeAll(() => ensureBuilt());

  it('with no stored credentials prints "Not logged in" and exits 0', async () => {
    await withTempDir(async (dir) => {
      const r = await runCli(['whoami'], { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } });
      expect(r.code).toBe(0);
      expect(combined(r)).toContain('Not logged in. Run:  mcpmake login');
    });
  });

  it('with stored creds and a 200 backend prints "Logged in as <email>"', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ whoami: 200, email: 'me@example.com', plan: 'team' });
      try {
        seedCreds(dir, { serverUrl: fc.url, token: 'mfd_stored_aaaa', email: 'stale@cache' });
        const r = await runCli(['whoami'], { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } });
        expect(r.code).toBe(0);
        const out = combined(r);
        // The email/plan come from the live whoami response, not the stored file.
        expect(out).toContain('Logged in as me@example.com (plan: team)');
        expect(out).toContain(`Server:    ${fc.url}`);
        // The stored token reached the backend as a bearer credential.
        const reqs = fc.capturedFor('/api/cli/whoami');
        expect(reqs).toHaveLength(1);
        expect(reqs[0].headers['authorization']).toBe('Bearer mfd_stored_aaaa');
      } finally {
        await fc.stop();
      }
    });
  });

  it('a 401 backend exits 1 and NEVER prints the token', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ whoami: 401 });
      const SECRET = 'mfd_secret_must_not_be_printed_5150';
      try {
        seedCreds(dir, { serverUrl: fc.url, token: SECRET });
        const r = await runCli(['whoami'], { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } });
        expect(r.code).toBe(1);
        const out = combined(r);
        expect(out).toContain('Stored token was rejected. Run `mcpmake login` again.');
        // Security contract: the token must not appear anywhere in CLI output.
        expect(r.stdout).not.toContain(SECRET);
        expect(r.stderr).not.toContain(SECRET);
        expect(out).not.toContain(SECRET);
      } finally {
        await fc.stop();
      }
    });
  });

  it('--token overrides the stored credential (explicit wins)', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ whoami: 200, email: 'flag@example.com' });
      try {
        seedCreds(dir, { serverUrl: fc.url, token: 'mfd_stored_should_lose' });
        const r = await runCli(['whoami', '--server', fc.url, '--token', 'mfd_flag_wins_1'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(0);
        const reqs = fc.capturedFor('/api/cli/whoami');
        expect(reqs).toHaveLength(1);
        // The --token flag, not the stored token, crossed the wire.
        expect(reqs[0].headers['authorization']).toBe('Bearer mfd_flag_wins_1');
      } finally {
        await fc.stop();
      }
    });
  });

  it('MCPMAKE_DEPLOY_TOKEN beats the stored credential but loses to --token', async () => {
    await withTempDir(async (dir) => {
      // 1) env beats stored
      const fc1 = await startFakeCloud({ whoami: 200, email: 'env@example.com' });
      try {
        seedCreds(dir, { serverUrl: fc1.url, token: 'mfd_stored_x' });
        const r1 = await runCli(['whoami', '--server', fc1.url], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir, MCPMAKE_DEPLOY_TOKEN: 'mfd_env_token_22' },
        });
        expect(r1.code).toBe(0);
        const reqs1 = fc1.capturedFor('/api/cli/whoami');
        expect(reqs1).toHaveLength(1);
        expect(reqs1[0].headers['authorization']).toBe('Bearer mfd_env_token_22');
      } finally {
        await fc1.stop();
      }

      // 2) --token beats env (full precedence: explicit > env > stored)
      const fc2 = await startFakeCloud({ whoami: 200, email: 'env@example.com' });
      try {
        const r2 = await runCli(['whoami', '--server', fc2.url, '--token', 'mfd_flag_top_33'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir, MCPMAKE_DEPLOY_TOKEN: 'mfd_env_token_22' },
        });
        expect(r2.code).toBe(0);
        const reqs2 = fc2.capturedFor('/api/cli/whoami');
        expect(reqs2).toHaveLength(1);
        expect(reqs2[0].headers['authorization']).toBe('Bearer mfd_flag_top_33');
      } finally {
        await fc2.stop();
      }
    });
  });
});
