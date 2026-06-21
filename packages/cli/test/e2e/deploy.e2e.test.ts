/**
 * Sprint E4 — `mcpmake deploy` end-to-end.
 *
 * Spawns the built bin to upload a spec to the loopback fake cloud and asserts:
 *   - exit 0 on success, with the ISSUED bearer token redacted by default and
 *     revealed only under --show-token;
 *   - the multipart request actually reached the server (captured body + headers);
 *   - the validation branches (wrong extension, missing file, >5MB) and the
 *     server-error branches (4xx JSON, 5xx plaintext);
 *   - the credential-channel policy: a token to a loopback http target is allowed
 *     (with a warning, no MCPMAKE_INSECURE needed), but a token to a non-loopback
 *     http target is REFUSED unless MCPMAKE_INSECURE=1 is set.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { startFakeCloud } from './helpers/fake-cloud.js';
import { E2E } from './helpers/gating.js';

const SPEC = JSON.stringify({ openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {} });

function writeSpec(dir: string, name = 'spec.json', body = SPEC): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe.skipIf(!E2E)('e2e deploy: upload + redaction + channel policy', () => {
  beforeAll(() => ensureBuilt());

  it('uploads a valid spec to a loopback target: exit 0, token redacted, body captured', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ deploy: 'ok', deployBearerToken: 'srv_issued_e4_9876' });
      try {
        const spec = writeSpec(dir);
        const r = await runCli(
          ['deploy', spec, '--server', fc.url, '--token', 'mfd_deploy_tok_abcd'],
          { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } },
        );
        expect(r.code).toBe(0);

        const out = combined(r);
        expect(out).toContain('Server deployed!');
        expect(out).toContain('demo-slug');
        expect(out).toContain('Tools:    3');
        // Issued bearer token redacted by default: last 4 shown, full value hidden,
        // and scrubbed from the Claude Desktop config block.
        expect(out).not.toContain('srv_issued_e4_9876');
        expect(out).toContain('…9876');
        expect(out).toContain('<REDACTED_TOKEN>');
        expect(out).toContain('Re-run with --show-token to reveal');

        // The multipart upload reached the server with the right shape.
        const reqs = fc.capturedFor('/api/servers');
        expect(reqs).toHaveLength(1);
        const req = reqs[0];
        expect(req.method).toBe('POST');
        expect(req.headers['authorization']).toBe('Bearer mfd_deploy_tok_abcd');
        expect(String(req.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
        const bodyText = req.body.toString('utf8');
        expect(bodyText).toContain(
          'Content-Disposition: form-data; name="spec"; filename="spec.json"',
        );
        // The spec bytes themselves are present in the captured body.
        expect(bodyText).toContain('"openapi":"3.0.0"');
      } finally {
        await fc.stop();
      }
    });
  });

  it('--show-token reveals the issued bearer token in full', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ deploy: 'ok', deployBearerToken: 'srv_issued_e4_reveal' });
      try {
        const spec = writeSpec(dir);
        const r = await runCli(
          ['deploy', spec, '--server', fc.url, '--token', 'mfd_x', '--show-token'],
          { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } },
        );
        expect(r.code).toBe(0);
        const out = combined(r);
        expect(out).toContain('srv_issued_e4_reveal');
        expect(out).not.toContain('<REDACTED_TOKEN>');
      } finally {
        await fc.stop();
      }
    });
  });

  it('a token to a loopback http target is allowed but warns about the unencrypted channel', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ deploy: 'ok' });
      try {
        const spec = writeSpec(dir);
        // No MCPMAKE_INSECURE here: loopback is permitted by the channel policy.
        const r = await runCli(['deploy', spec, '--server', fc.url, '--token', 'mfd_x'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(0);
        expect(combined(r)).toMatch(/unencrypted channel/i);
      } finally {
        await fc.stop();
      }
    });
  });

  it('rejects a wrong-extension spec file with exit 1', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ deploy: 'ok' });
      try {
        const spec = writeSpec(dir, 'spec.txt', 'hello');
        const r = await runCli(['deploy', spec, '--server', fc.url, '--token', 'mfd_x'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(1);
        expect(combined(r)).toContain('Invalid file type. Accepted: .yaml, .yml, .json, .har');
        // Validation fails before any upload.
        expect(fc.capturedFor('/api/servers')).toHaveLength(0);
      } finally {
        await fc.stop();
      }
    });
  });

  it('rejects a missing spec file with exit 1 and a "File not found" message', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ deploy: 'ok' });
      try {
        const missing = join(dir, 'does-not-exist.json');
        const r = await runCli(['deploy', missing, '--server', fc.url, '--token', 'mfd_x'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(1);
        expect(combined(r)).toContain(`File not found: ${missing}`);
        expect(fc.capturedFor('/api/servers')).toHaveLength(0);
      } finally {
        await fc.stop();
      }
    });
  });

  it('rejects a spec larger than 5MB with exit 1', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ deploy: 'ok' });
      try {
        // 5 MB + 1 byte of valid-extension content trips the size guard.
        const big = 'a'.repeat(5 * 1024 * 1024 + 1);
        const spec = writeSpec(dir, 'big.json', big);
        const r = await runCli(['deploy', spec, '--server', fc.url, '--token', 'mfd_x'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(1);
        expect(combined(r)).toMatch(/Spec file too large .*Maximum is 5MB/);
        expect(fc.capturedFor('/api/servers')).toHaveLength(0);
      } finally {
        await fc.stop();
      }
    });
  });

  it('surfaces a 4xx JSON error from the server (exit 1)', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({
        deploy: '4xx',
        deployErrorMessage: 'spec was invalid: missing paths',
      });
      try {
        const spec = writeSpec(dir);
        const r = await runCli(['deploy', spec, '--server', fc.url, '--token', 'mfd_x'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(1);
        expect(combined(r)).toContain('Deploy failed: spec was invalid: missing paths');
      } finally {
        await fc.stop();
      }
    });
  });

  it('surfaces a 5xx plaintext error from the server (exit 1)', async () => {
    await withTempDir(async (dir) => {
      const fc = await startFakeCloud({ deploy: '5xx' });
      try {
        const spec = writeSpec(dir);
        const r = await runCli(['deploy', spec, '--server', fc.url, '--token', 'mfd_x'], {
          cwd: dir,
          env: { MCPMAKE_CONFIG_DIR: dir },
        });
        expect(r.code).toBe(1);
        expect(combined(r)).toContain('Deploy failed: Server returned 500: internal boom');
      } finally {
        await fc.stop();
      }
    });
  });

  it('refuses to send a token to a NON-loopback http target without MCPMAKE_INSECURE', async () => {
    await withTempDir(async (dir) => {
      const spec = writeSpec(dir);
      // example.com is non-loopback; the channel guard fires before any socket
      // is opened, so the (irrelevant) port never matters.
      const r = await runCli(
        ['deploy', spec, '--server', 'http://deploy.example.com', '--token', 'mfd_x'],
        { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir } },
      );
      expect(r.code).toBe(1);
      const out = combined(r);
      expect(out).toMatch(/Refusing to send credentials .* over an unencrypted/i);
      // The refusal never leaks the token.
      expect(out).not.toContain('mfd_x');
    });
  });

  it('MCPMAKE_INSECURE=1 lets a token cross a non-loopback http channel (fails at network, not the guard)', async () => {
    await withTempDir(async (dir) => {
      const spec = writeSpec(dir);
      // Closed port 1 → the guard lets it through, then it fails at the transport
      // with a connection error rather than an /unencrypted/ refusal.
      const r = await runCli(
        ['deploy', spec, '--server', 'http://deploy.example.com:1', '--token', 'mfd_x'],
        { cwd: dir, env: { MCPMAKE_CONFIG_DIR: dir, MCPMAKE_INSECURE: '1' }, timeoutMs: 40_000 },
      );
      expect(r.code).toBe(1);
      const out = combined(r);
      // It got past the channel guard (warned about plaintext) and only failed
      // when the upload itself could not connect.
      expect(out).toMatch(/unencrypted channel/i);
      expect(out).toContain('Deploy failed:');
      expect(out).not.toMatch(/Refusing to send credentials/i);
    });
  });
});
