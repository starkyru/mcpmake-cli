/**
 * Sprint E1 — `--target` / `--format` deployment-target matrix end-to-end.
 *
 * Drives `from openapi` (petstore) across the three real emit targets and proves
 * each produces a *distinct, runnable* server shape, not just any tree:
 *   - node       → stdio MCP server (StdioServerTransport in src/index.ts)
 *   - cloudflare → HTTP Workers project (wrangler.toml + Fetch handler)
 *   - python     → server.py + requirements.txt
 * Plus the unsupported combination `--target cloudflare --format python` which
 * the command rejects with a non-zero exit before writing anything.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { assertTreeContains } from './helpers/assert-tree.js';
import { E2E } from './helpers/gating.js';

const SPEC = fileURLToPath(new URL('../fixtures/petstore.yaml', import.meta.url));

describe.skipIf(!E2E)('e2e: --target / --format matrix (openapi petstore)', () => {
  beforeAll(() => ensureBuilt());

  it('node (default) emits a stdio MCP server', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--target', 'node'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      expect(combined(r)).not.toContain('Cloudflare Workers');
      // Node entrypoint wires the SDK stdio transport.
      const index = readFileSync(join(out, 'src/index.ts'), 'utf8');
      expect(index).toContain(
        "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'",
      );
      expect(index).toContain('new StdioServerTransport()');
      // npm-runnable Node project (no wrangler).
      const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts.start).toBe('node dist/index.js');
      expect(existsSync(join(out, 'wrangler.toml'))).toBe(false);
    });
  });

  it('cloudflare emits an HTTP Workers project (wrangler.toml + Fetch handler)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--target', 'cloudflare'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      expect(combined(r)).toContain('(Cloudflare Workers)');

      assertTreeContains(out, ['wrangler.toml', 'src/index.ts', '.dev.vars.example']);
      const wrangler = readFileSync(join(out, 'wrangler.toml'), 'utf8');
      expect(wrangler).toContain('main = "src/index.ts"');
      // Workers entry is a Fetch handler, NOT a stdio transport.
      const index = readFileSync(join(out, 'src/index.ts'), 'utf8');
      expect(index).not.toContain('StdioServerTransport');
      expect(index).toContain('async fetch(');
      // wrangler is the deploy toolchain.
      const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts.deploy).toBe('wrangler deploy');
    });
  });

  it('python emits server.py + requirements.txt (FastMCP)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--format', 'python'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      assertTreeContains(out, ['server.py', 'requirements.txt']);
      const server = readFileSync(join(out, 'server.py'), 'utf8');
      expect(server).toContain('from mcp.server.fastmcp import FastMCP');
      const reqs = readFileSync(join(out, 'requirements.txt'), 'utf8');
      expect(reqs).toContain('mcp');
      // No TypeScript project artifacts in a Python emit.
      expect(existsSync(join(out, 'package.json'))).toBe(false);
      expect(existsSync(join(out, 'src/index.ts'))).toBe(false);
    });
  });

  it('--target cloudflare --format python is rejected (exit 1) and writes nothing', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'openapi', SPEC, '-o', out, '--target', 'cloudflare', '--format', 'python'],
        { cwd: dir },
      );

      expect(r.code).toBe(1);
      expect(combined(r)).toContain(
        '--target cloudflare is only available for TypeScript output (not --format python)',
      );
      // The guard fires before emit — nothing is written.
      expect(existsSync(out)).toBe(false);
    });
  });
});
