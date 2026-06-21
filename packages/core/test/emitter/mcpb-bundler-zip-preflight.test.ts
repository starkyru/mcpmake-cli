import { describe, it, expect } from 'vitest';
import { assertZipAvailable } from '../../src/emitter/mcpb-bundler.js';

// R2-E / L-mcpb — the .mcpb bundler shells out to the system `zip` binary. On
// Windows / minimal Alpine (no `zip`) the spawn used to fail with an opaque
// ENOENT. assertZipAvailable() is the preflight seam: it consults an injectable
// presence-checker (the only external boundary — a real `zip -v` spawn in prod)
// and, when zip is absent, throws a clear, actionable install-guidance error.
//
// These tests inject the checker (the genuine external boundary). They do NOT
// mock assertZipAvailable itself — the unit under test runs for real.
describe('R2-E — mcpb bundler zip preflight', () => {
  it('throws actionable install guidance when zip is absent', async () => {
    // checker resolves false === binary not on PATH.
    await expect(assertZipAvailable(async () => false)).rejects.toThrow(
      'The `zip` binary is required to build an .mcpb bundle but was not found on PATH.',
    );
  });

  it('surfaces concrete install commands for Debian/Ubuntu and Alpine', async () => {
    // Pin the load-bearing remediation substrings so a regression that drops the
    // package-manager guidance fails here rather than silently shipping a vaguer
    // message.
    await expect(assertZipAvailable(async () => false)).rejects.toThrow('apt install zip');
    await expect(assertZipAvailable(async () => false)).rejects.toThrow('apk add zip');
  });

  it('resolves without throwing when zip is present', async () => {
    // checker resolves true === a working `zip` binary is on PATH.
    await expect(assertZipAvailable(async () => true)).resolves.toBeUndefined();
  });
});
