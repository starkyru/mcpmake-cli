/**
 * Sprint E1 — `mcpmake from postman` end-to-end.
 *
 * Uses a committed minimal Postman v2.1 collection (2 Bearer-auth requests on
 * GET/POST /widgets) so the conversion → cluster → operations pipeline yields
 * exactly 2 tools. Unlike HAR, the Postman command DOES build MCP resources +
 * prompts, so the Node tree includes resources.ts / prompts.ts and the
 * Cloudflare path warns that it drops them.
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

/** Committed Postman v2.1 fixture (2 requests, Bearer auth) created for this sprint. */
const COLLECTION = fileURLToPath(new URL('./fixtures/sample-collection.json', import.meta.url));

describe.skipIf(!E2E)('e2e: from postman (sample-collection.json)', () => {
  beforeAll(() => ensureBuilt());

  it('node generation yields 2 tools plus resources & prompts, and detects Bearer auth', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'postman', COLLECTION, '-o', out], { cwd: dir });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Found 2 requests in collection');
      expect(text).toContain('Clustered into 2 operations');
      expect(text).toContain('Tools generated: 2');

      // Server name derived from the collection's info.name ("Sample Widgets API").
      expect(text).toContain('MCP server generated at:');

      assertTreeEquals(out, [
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
        'src/tools/create-widget.ts',
        'src/tools/index.ts',
        'src/tools/list-widgets.ts',
        'src/trace.ts',
        'src/types.ts',
        'test/tools/create-widget.test.ts',
        'test/tools/list-widgets.test.ts',
        'tsconfig.json',
      ]);

      // Postman, unlike HAR, builds resources + prompts.
      expect(existsSync(join(out, 'src/resources.ts'))).toBe(true);
      expect(existsSync(join(out, 'src/prompts.ts'))).toBe(true);
      // Bearer auth was detected from the request's Authorization header.
      expect(readFileSync(join(out, '.env.example'), 'utf8')).toContain('BEARER_TOKEN=');
    });
  });

  it('--target cloudflare drops resources & prompts (1 each) and warns', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'postman', COLLECTION, '-o', out, '--target', 'cloudflare'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Tools generated: 2');
      // Exactly 1 resource + 1 prompt are built from the 2 ops, and both are dropped.
      expect(text).toContain(
        'Cloudflare target emits tools only — 1 resource(s) and 1 prompt(s) omitted.',
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
        'src/tools/create-widget.ts',
        'src/tools/index.ts',
        'src/tools/list-widgets.ts',
        'src/trace.ts',
        'test/server.test.ts',
        'tsconfig.json',
        'wrangler.toml',
      ]);
      expect(existsSync(join(out, 'src/resources.ts'))).toBe(false);
      expect(existsSync(join(out, 'src/prompts.ts'))).toBe(false);
    });
  });
});
