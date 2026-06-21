/**
 * Sprint E0 smoke test — proves the spawn-the-bin harness works and covers the
 * shim + `from` router that have *zero* in-process coverage today: `--version`,
 * `--help`, and the unknown-command path.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { E2E } from './helpers/gating.js';

/** The version `--version` must echo — read from the CLI package.json, not hardcoded. */
function cliVersion(): string {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

describe.skipIf(!E2E)('e2e smoke: bin shim + top-level router', () => {
  beforeAll(() => ensureBuilt());

  it('--version prints the package.json version and exits 0', async () => {
    const r = await runCli(['--version']);
    expect(r.code).toBe(0);
    expect(combined(r)).toContain(cliVersion());
  });

  it('--help lists the top-level commands and exits 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    const out = combined(r);
    // citty wraps the usage line in backticks: USAGE `mcpmake from|merge|...`.
    expect(out).toContain('USAGE');
    expect(out).toContain('mcpmake from|merge');
    // A representative spread of the registered subcommands.
    for (const cmd of ['from', 'merge', 'verify', 'deploy', 'lint', 'rescan']) {
      expect(out).toContain(cmd);
    }
  });

  it('from --help lists the generator subcommands (router coverage)', async () => {
    const r = await runCli(['from', '--help']);
    expect(r.code).toBe(0);
    const out = combined(r);
    for (const sub of ['openapi', 'har', 'postman', 'website', 'stainless']) {
      expect(out).toContain(sub);
    }
  });

  it('an unknown command errors and exits non-zero', async () => {
    const r = await runCli(['definitely-not-a-command']);
    // Confirms the bin shim + router reject typos with a real failure code, so a
    // mistyped command in a CI script does not silently "succeed".
    expect(r.code).toBe(1);
    expect(combined(r)).toContain('Unknown command');
  });
});
