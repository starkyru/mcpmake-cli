/**
 * Sprint E1 — `mcpmake from stainless` end-to-end.
 *
 * Migrates a Stainless config (code-mode MCP server) + the OpenAPI spec it
 * references into an owned per-endpoint mcpmake project. The fixtures are lifted
 * from the unit suite (stainless.test.ts): a code-mode `stainless.yml` whose
 * `openapi.path` points at a sibling `openapi.yml` with 6 operations across
 * accounts + cards. This tier drives the real bin (config read → spec load →
 * translate → emit) and asserts the migration report, the code-mode warning, and
 * the per-target/format trees.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { assertTreeEquals } from './helpers/assert-tree.js';
import { E2E } from './helpers/gating.js';

/** Committed Stainless config; `openapi.path: openapi.yml` resolves to the sibling spec. */
const CONFIG = fileURLToPath(new URL('./fixtures/stainless.yml', import.meta.url));
/** The spec the config references — used directly by the --spec override test. */
const SPEC = fileURLToPath(new URL('./fixtures/openapi.yml', import.meta.url));

/** Exact Node tree — 27 files (6 tools + their tests + resources/prompts/types). */
const NODE_TREE = [
  '.env.example',
  '.gitignore',
  'README.md',
  'package.json',
  'src/auth.ts',
  'src/config.ts',
  'src/http.ts',
  'src/index.ts',
  'src/prompts.ts',
  'src/resources.ts',
  'src/response-filter.ts',
  'src/tools/create-account.ts',
  'src/tools/create-card.ts',
  'src/tools/create-issuing-card.ts',
  'src/tools/delete-account.ts',
  'src/tools/get-account.ts',
  'src/tools/index.ts',
  'src/tools/list-accounts.ts',
  'src/trace.ts',
  'src/types.ts',
  'test/tools/create-account.test.ts',
  'test/tools/create-card.test.ts',
  'test/tools/create-issuing-card.test.ts',
  'test/tools/delete-account.test.ts',
  'test/tools/get-account.test.ts',
  'test/tools/list-accounts.test.ts',
  'tsconfig.json',
];

describe.skipIf(!E2E)('e2e: from stainless (stainless.yml → owned server)', () => {
  beforeAll(() => ensureBuilt());

  it('migrates the config into a 6-tool owned server with serverName from the spec title', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'stainless', CONFIG, '-o', out], { cwd: dir });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Found 6 operations');
      // serverName is derived from the OpenAPI info.title "Acme API" → acme-api.
      expect(text).toContain('Generating typescript MCP server: acme-api');

      // Migration report lines (printMigrationReport).
      expect(text).toContain('Stainless → mcpmake migration report:');
      expect(text).toContain('6 owned, editable tool(s) generated.');
      expect(text).toContain('Environments: production, sandbox');
      expect(text).toContain('Auth: pinned to security scheme "bearerAuth".');
      expect(text).toContain('Auth: credential read from env var "ACME_API_KEY" (read_env).');
      expect(text).toContain('Response unwrap: applied a jq filter to 1 operation(s).');

      // Code-mode warning — mcpmake has no sandbox/code-exec analog.
      expect(text).toContain('Stainless code-mode MCP server detected');

      assertTreeEquals(out, NODE_TREE);
      // read_env renamed the credential env var.
      expect(readFileSync(join(out, '.env.example'), 'utf8')).toContain('ACME_API_KEY=');
    });
  });

  it('--spec override + --exclude filters cards, leaving 4 tools', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'stainless', CONFIG, '-o', out, '--spec', SPEC, '--exclude', '/cards*'],
        { cwd: dir },
      );

      expect(r.code).toBe(0);
      const text = combined(r);
      // 6 ops found, /cards + /cards/issuing excluded → 4 remain.
      expect(text).toContain('Found 6 operations');
      expect(text).toContain('4 operations after filtering');
      expect(text).toContain('4 owned, editable tool(s) generated.');

      // The two card tools must be gone; the four account tools must remain.
      expect(existsSync(join(out, 'src/tools/create-card.ts'))).toBe(false);
      expect(existsSync(join(out, 'src/tools/create-issuing-card.ts'))).toBe(false);
      expect(existsSync(join(out, 'src/tools/create-account.ts'))).toBe(true);
      expect(existsSync(join(out, 'src/tools/list-accounts.ts'))).toBe(true);
      expect(existsSync(join(out, 'src/tools/get-account.ts'))).toBe(true);
      expect(existsSync(join(out, 'src/tools/delete-account.ts'))).toBe(true);
    });
  });

  it('--base-url overrides the config environments (warns + seeds BASE_URL)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'stainless', CONFIG, '-o', out, '--base-url', 'https://proxy.internal/v1'],
        { cwd: dir },
      );

      expect(r.code).toBe(0);
      expect(combined(r)).toContain('--base-url overrides the Stainless `environments`');
      const env = readFileSync(join(out, '.env.example'), 'utf8');
      expect(env).toContain('BASE_URL=https://proxy.internal/v1');
      // Environments seeding suppressed → no active MCP_ENVIRONMENTS line.
      expect(env).not.toMatch(/^MCP_ENVIRONMENTS=/m);
    });
  });

  it('--format python emits a 3-file Python project and still reports the migration', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'stainless', CONFIG, '-o', out, '--format', 'python'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Generating python MCP server: acme-api');
      expect(text).toContain('6 owned, editable tool(s) generated.');
      assertTreeEquals(out, ['.env.example', 'requirements.txt', 'server.py']);
    });
  });

  it('--target cloudflare emits a Workers tree and drops resources/prompts', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'stainless', CONFIG, '-o', out, '--target', 'cloudflare'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('(Cloudflare Workers)');
      expect(text).toContain(
        'Cloudflare target emits tools only — 2 resource(s) and 1 prompt(s) omitted.',
      );

      assertTreeEquals(out, [
        '.dev.vars.example',
        '.gitignore',
        'README.md',
        'package.json',
        'src/auth.ts',
        'src/config.ts',
        'src/http.ts',
        'src/index.ts',
        'src/response-filter.ts',
        'src/tools/create-account.ts',
        'src/tools/create-card.ts',
        'src/tools/create-issuing-card.ts',
        'src/tools/delete-account.ts',
        'src/tools/get-account.ts',
        'src/tools/index.ts',
        'src/tools/list-accounts.ts',
        'src/trace.ts',
        'test/server.test.ts',
        'tsconfig.json',
        'wrangler.toml',
      ]);
    });
  });

  it('--target cloudflare --format python is rejected (exit 1, TypeScript-only)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'stainless', CONFIG, '-o', out, '--target', 'cloudflare', '--format', 'python'],
        { cwd: dir },
      );

      expect(r.code).toBe(1);
      expect(combined(r)).toContain('--target cloudflare is only available for TypeScript output');
      expect(existsSync(out)).toBe(false);
    });
  });
});
