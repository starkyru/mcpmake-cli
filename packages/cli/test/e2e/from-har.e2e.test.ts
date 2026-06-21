/**
 * Sprint E1 — `mcpmake from har` end-to-end.
 *
 * The HAR pipeline (filter → normalize → dedup → cluster → operations) only
 * emits tools (no MCP resources/prompts), so its tree differs from the OpenAPI
 * one. We pin `--name` so the server name is deterministic (otherwise it is
 * derived from the captured host) and assert the exact tool set, the tools-only
 * tree, and the "Tools generated" / "Auth detected" report lines.
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

/** Committed HAR fixture in @mcpmake/core — 7 entries → 5 API → 4 user operations. */
const HAR = fileURLToPath(new URL('../../../core/test/fixtures/sample-api.har', import.meta.url));

/** Deterministic server name so generated package.json / messages are stable. */
const NAME = 'sample-har-server';

/** Exact Node tree — 21 files: NO resources.ts / prompts.ts (HAR emits tools only). */
const NODE_TREE = [
  '.env.example',
  '.gitignore',
  'README.md',
  'package.json',
  'src/auth.ts',
  'src/config.ts',
  'src/http.ts',
  'src/index.ts',
  'src/response-filter.ts',
  'src/tools/create-user.ts',
  'src/tools/delete-user.ts',
  'src/tools/get-user.ts',
  'src/tools/index.ts',
  'src/tools/list-users.ts',
  'src/trace.ts',
  'src/types.ts',
  'test/tools/create-user.test.ts',
  'test/tools/delete-user.test.ts',
  'test/tools/get-user.test.ts',
  'test/tools/list-users.test.ts',
  'tsconfig.json',
];

describe.skipIf(!E2E)('e2e: from har (sample-api.har)', () => {
  beforeAll(() => ensureBuilt());

  it('generates exactly 4 tools, no resources/prompts, and reports detected auth', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'har', HAR, '-o', out, '--name', NAME], { cwd: dir });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Clustered into 4 operations');
      expect(text).toContain(`Generating typescript MCP server: ${NAME}`);
      // Exact report lines from har.ts.
      expect(text).toContain('Tools generated: 4');
      expect(text).toContain('Auth detected: bearer');

      assertTreeEquals(out, NODE_TREE);
      // HAR never builds MCP resources or prompts.
      expect(existsSync(join(out, 'src/resources.ts'))).toBe(false);
      expect(existsSync(join(out, 'src/prompts.ts'))).toBe(false);
      // Bearer auth detected from the HAR → BEARER_TOKEN env var seeded.
      expect(readFileSync(join(out, '.env.example'), 'utf8')).toContain('BEARER_TOKEN=');
    });
  });

  it('--format python emits a 3-file Python project and still reports 4 tools', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'har', HAR, '-o', out, '--name', NAME, '--format', 'python'],
        { cwd: dir },
      );

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Generating python MCP server:');
      expect(text).toContain('Tools generated: 4');
      assertTreeEquals(out, ['.env.example', 'requirements.txt', 'server.py']);
    });
  });

  it('--target cloudflare emits a tools-only Workers tree with wrangler.toml', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'har', HAR, '-o', out, '--name', NAME, '--target', 'cloudflare'],
        { cwd: dir },
      );

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('(Cloudflare Workers)');
      expect(text).toContain('Tools generated: 4');

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
        'src/tools/create-user.ts',
        'src/tools/delete-user.ts',
        'src/tools/get-user.ts',
        'src/tools/index.ts',
        'src/tools/list-users.ts',
        'src/trace.ts',
        'test/server.test.ts',
        'tsconfig.json',
        'wrangler.toml',
      ]);
      // HAR has no resources/prompts to begin with, so the Workers "omitted"
      // warning that the OpenAPI/Postman paths print must NOT appear here.
      expect(text).not.toContain('resource(s) and');
    });
  });

  it('--dry-run previews 4 tools without writing the output directory', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'har', HAR, '-o', out, '--name', NAME, '--dry-run'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      expect(combined(r)).toContain('[dry-run] Would write: src/tools/list-users.ts');
      expect(existsSync(out)).toBe(false);
    });
  });
});
