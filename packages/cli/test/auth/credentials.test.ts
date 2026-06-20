import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  looksLikeDeployToken,
  resolveDeployToken,
  saveCredentials,
  loadCredentials,
  clearCredentials,
  credentialsPath,
  type Credentials,
} from '../../src/auth/credentials.js';

let dir: string;
const ORIG = process.env.MCPMAKE_CONFIG_DIR;
const ORIG_TOKEN = process.env.MCPMAKE_DEPLOY_TOKEN;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpmake-cred-'));
  process.env.MCPMAKE_CONFIG_DIR = dir;
  delete process.env.MCPMAKE_DEPLOY_TOKEN;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG === undefined) delete process.env.MCPMAKE_CONFIG_DIR;
  else process.env.MCPMAKE_CONFIG_DIR = ORIG;
  if (ORIG_TOKEN === undefined) delete process.env.MCPMAKE_DEPLOY_TOKEN;
  else process.env.MCPMAKE_DEPLOY_TOKEN = ORIG_TOKEN;
});

describe('looksLikeDeployToken', () => {
  it('only accepts the mfd_ prefix', () => {
    expect(looksLikeDeployToken('mfd_abc')).toBe(true);
    expect(looksLikeDeployToken('mf_abc')).toBe(false);
    expect(looksLikeDeployToken('admin-token')).toBe(false);
    expect(looksLikeDeployToken(undefined)).toBe(false);
  });
});

describe('resolveDeployToken precedence', () => {
  const stored: Credentials = { serverUrl: 'https://a.example', token: 'mfd_stored' };

  it('prefers an explicit token over everything', () => {
    process.env.MCPMAKE_DEPLOY_TOKEN = 'mfd_env';
    expect(
      resolveDeployToken({ explicit: 'mfd_explicit', serverUrl: 'https://a.example', stored }),
    ).toBe('mfd_explicit');
  });

  it('falls back to the env var', () => {
    process.env.MCPMAKE_DEPLOY_TOKEN = 'mfd_env';
    expect(resolveDeployToken({ serverUrl: 'https://a.example', stored })).toBe('mfd_env');
  });

  it('uses the stored token only when the server matches', () => {
    expect(resolveDeployToken({ serverUrl: 'https://a.example', stored })).toBe('mfd_stored');
    // a stored token is never sent to a DIFFERENT backend
    expect(resolveDeployToken({ serverUrl: 'https://other.example', stored })).toBeUndefined();
  });

  it('returns undefined when nothing is available', () => {
    expect(resolveDeployToken({ serverUrl: 'https://a.example', stored: null })).toBeUndefined();
  });
});

describe('save / load / clear', () => {
  it('round-trips and writes the file 0600', async () => {
    await saveCredentials({ serverUrl: 'https://x.example', token: 'mfd_xyz', email: 'a@b.c' });
    const loaded = await loadCredentials();
    expect(loaded).toEqual({ serverUrl: 'https://x.example', token: 'mfd_xyz', email: 'a@b.c' });

    const mode = statSync(credentialsPath()).mode & 0o777;
    expect(mode).toBe(0o600);

    await clearCredentials();
    expect(await loadCredentials()).toBeNull();
  });

  it('returns null for a malformed / token-less file', async () => {
    await saveCredentials({ serverUrl: 'https://x.example', token: '' } as Credentials);
    expect(await loadCredentials()).toBeNull();
  });
});
