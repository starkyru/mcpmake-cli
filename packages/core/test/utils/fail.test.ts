/**
 * Unit tests for the pure helpers in `fail.ts`.
 *
 * IMPORTANT: `fail()` itself calls `process.exit(1)`, which would kill the test
 * runner — it is NEVER invoked here. We only exercise the exported pure helpers
 * (`redactText`, `resolveTelemetryMode`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import { redactText, resolveTelemetryMode } from '../../src/utils/fail.js';

describe('redactText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces the current user's home directory with ~", () => {
    const home = os.homedir();
    const input = `failed to read ${home}/projects/secret/file.ts`;
    expect(redactText(input)).toBe('failed to read ~/projects/secret/file.ts');
  });

  it('redacts /Users/<name>/ and /home/<name>/ paths (other users / CI logs)', () => {
    expect(redactText('open /Users/alice/.aws/credentials')).toBe('open ~/.aws/credentials');
    expect(redactText('open /home/bob/.ssh/id_rsa')).toBe('open ~/.ssh/id_rsa');
  });

  it('redacts Bearer tokens', () => {
    expect(redactText('Authorization: Bearer sk-abc123XYZ')).toBe(
      'Authorization: Bearer [redacted]',
    );
  });

  it('redacts mcpmake-style mf_ tokens', () => {
    expect(redactText('token mf_deadbeef0123 expired')).toBe('token mf_[redacted] expired');
  });

  it('redacts URL query strings (creds embedded in URLs)', () => {
    expect(redactText('GET https://api.example.com/v1?api_key=topsecret&u=1')).toBe(
      'GET https://api.example.com/v1?[redacted]',
    );
  });

  it('applies all redactions together', () => {
    const home = os.homedir();
    const input =
      `Error at ${home}/app: GET https://x.test/p?token=abc with Bearer xyz789 ` +
      `and key mf_cafef00d`;
    const out = redactText(input);
    expect(out).not.toContain(home);
    expect(out).toContain('~/app');
    expect(out).toContain('?[redacted]');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('mf_[redacted]');
    expect(out).not.toContain('abc');
    expect(out).not.toContain('xyz789');
    expect(out).not.toContain('cafef00d');
  });

  it('leaves clean strings untouched', () => {
    expect(redactText('just a normal error message')).toBe('just a normal error message');
  });
});

describe('resolveTelemetryMode', () => {
  it('returns the configured mode on an interactive TTY outside CI', () => {
    expect(resolveTelemetryMode({ configured: 'prompt', isTTY: true, ci: false })).toBe('prompt');
    expect(resolveTelemetryMode({ configured: 'auto', isTTY: true, ci: false })).toBe('auto');
    expect(resolveTelemetryMode({ configured: 'off', isTTY: true, ci: false })).toBe('off');
  });

  it('defaults to prompt when the configured value is missing or invalid', () => {
    expect(resolveTelemetryMode({ configured: undefined, isTTY: true, ci: false })).toBe('prompt');
    expect(resolveTelemetryMode({ configured: 'nonsense', isTTY: true, ci: false })).toBe('prompt');
    expect(resolveTelemetryMode({ configured: 123, isTTY: true, ci: false })).toBe('prompt');
  });

  it('degrades to off in CI even when configured to auto/prompt', () => {
    expect(resolveTelemetryMode({ configured: 'auto', isTTY: true, ci: true })).toBe('off');
    expect(resolveTelemetryMode({ configured: 'prompt', isTTY: true, ci: true })).toBe('off');
  });

  it('degrades to off when stdout is not a TTY (piped / non-interactive)', () => {
    expect(resolveTelemetryMode({ configured: 'auto', isTTY: false, ci: false })).toBe('off');
    expect(resolveTelemetryMode({ configured: 'prompt', isTTY: false, ci: false })).toBe('off');
  });
});
