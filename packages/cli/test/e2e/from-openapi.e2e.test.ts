/**
 * Sprint E1 — `mcpmake from openapi` end-to-end.
 *
 * Spawns the built bin against the committed petstore fixture and asserts the
 * real generated file tree, exit codes, and stdout/stderr for every target /
 * format / overwrite combination. The fast unit tier mocks the emitter and the
 * spec loader (see openapi.test.ts), so this is the only tier that proves the
 * full pipeline (spec → operations → tools → emitted project) actually lands the
 * right files on disk through the bin shim + citty arg parsing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { assertTreeEquals, listTree } from './helpers/assert-tree.js';
import { E2E } from './helpers/gating.js';

/** Committed OpenAPI fixture (4 operations: list/create/show/delete pet). */
const SPEC = fileURLToPath(new URL('../fixtures/petstore.yaml', import.meta.url));

/** The exact Node (default) project tree petstore must produce — 23 files. */
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
  'src/tools/create-pet.ts',
  'src/tools/delete-pet.ts',
  'src/tools/index.ts',
  'src/tools/list-pets.ts',
  'src/tools/show-pet-by-id.ts',
  'src/trace.ts',
  'src/types.ts',
  'test/tools/create-pet.test.ts',
  'test/tools/delete-pet.test.ts',
  'test/tools/list-pets.test.ts',
  'test/tools/show-pet-by-id.test.ts',
  'tsconfig.json',
];

/** The exact Cloudflare Workers tree — 18 files: gains wrangler.toml + .dev.vars.example, loses resources/prompts/types + per-tool tests. */
const CLOUDFLARE_TREE = [
  '.dev.vars.example',
  '.gitignore',
  'README.md',
  'package.json',
  'src/auth.ts',
  'src/config.ts',
  'src/http.ts',
  'src/index.ts',
  'src/response-filter.ts',
  'src/tools/create-pet.ts',
  'src/tools/delete-pet.ts',
  'src/tools/index.ts',
  'src/tools/list-pets.ts',
  'src/tools/show-pet-by-id.ts',
  'src/trace.ts',
  'test/server.test.ts',
  'tsconfig.json',
  'wrangler.toml',
];

describe.skipIf(!E2E)('e2e: from openapi (petstore)', () => {
  beforeAll(() => ensureBuilt());

  it('default (node) generation writes the exact 23-file tree and exits 0', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'openapi', SPEC, '-o', out], { cwd: dir });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Found 4 operations');
      expect(text).toContain('Generating typescript MCP server: swagger-petstore');
      expect(text).toContain('MCP server generated at:');

      assertTreeEquals(out, NODE_TREE);
    });
  });

  // Count per-tool files (one src/tools/<name>.ts per operation; index.ts is the registry).
  const toolFiles = (out: string): string[] =>
    listTree(out).filter((f) => /^src\/tools\/.+\.ts$/.test(f) && f !== 'src/tools/index.ts');

  it('--interactive curates operations before generation (keep-all vs exclude-one)', async () => {
    await withTempDir(async (dir) => {
      // Keep all: pressing Enter (empty answer) keeps every operation → all 4 tools.
      const outAll = join(dir, 'all');
      const rAll = await runCli(['from', 'openapi', SPEC, '-o', outAll, '--interactive'], {
        cwd: dir,
        input: '\n',
      });
      expect(rAll.code, combined(rAll)).toBe(0);
      // confirmOperations lists the operations for review.
      expect(combined(rAll)).toContain('Detected 4 operations');
      expect(toolFiles(outAll).length).toBe(4);

      // Exclude operation #1 → it is dropped: 3 tools generated.
      const outSel = join(dir, 'sel');
      const rSel = await runCli(['from', 'openapi', SPEC, '-o', outSel, '--interactive'], {
        cwd: dir,
        input: '1\n',
      });
      expect(rSel.code, combined(rSel)).toBe(0);
      expect(combined(rSel)).toContain('Proceeding with 3 operations');
      expect(toolFiles(outSel).length).toBe(3);
    });
  });

  it('--mcp-ui emits a ui:// tool-launcher module and registers it in the server', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--mcp-ui'], { cwd: dir });
      expect(r.code, combined(r)).toBe(0);

      // The MCP Apps module is emitted and registered in the server entry.
      expect(listTree(out)).toContain('src/mcp-ui.ts');
      expect(readFileSync(join(out, 'src/index.ts'), 'utf8')).toContain('registerMcpUi(server)');

      // The module exposes a conformant UIResource (ui:// + mcp-app MIME) carrying the tools.
      const ui = readFileSync(join(out, 'src/mcp-ui.ts'), 'utf8');
      expect(ui).toContain('ui://swagger-petstore/tools');
      expect(ui).toContain('text/html;profile=mcp-app');
      expect(ui).toContain("window.parent.postMessage({ type: 'tool'");
      expect(ui).toContain('list_pets');
    });
  });

  it('default generation does NOT emit the mcp-ui module (opt-in)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      await runCli(['from', 'openapi', SPEC, '-o', out], { cwd: dir });
      expect(existsSync(join(out, 'src/mcp-ui.ts'))).toBe(false);
      expect(readFileSync(join(out, 'src/index.ts'), 'utf8')).not.toContain('registerMcpUi');
    });
  });

  it('--dry-run previews files but writes nothing to disk', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--dry-run'], { cwd: dir });

      expect(r.code).toBe(0);
      // Dry-run prints "[dry-run] Would write:" for each file it would emit…
      expect(combined(r)).toContain('[dry-run] Would write: src/index.ts');
      // …but the output directory is never created.
      expect(existsSync(out)).toBe(false);
    });
  });

  it('--target cloudflare emits wrangler.toml, drops resources/prompts, and warns', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--target', 'cloudflare'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('(Cloudflare Workers)');
      // The Workers target is tools-only — it explicitly reports what it omits.
      expect(text).toContain(
        'Cloudflare target emits tools only — 2 resource(s) and 1 prompt(s) omitted.',
      );

      assertTreeEquals(out, CLOUDFLARE_TREE);
      // Spot-check the Workers manifest is real and bound to the spec.
      const wrangler = readFileSync(join(out, 'wrangler.toml'), 'utf8');
      expect(wrangler).toContain('name = "swagger-petstore"');
      expect(wrangler).toContain('main = "src/index.ts"');
      // resources/prompts must NOT be on disk for the Workers target.
      expect(existsSync(join(out, 'src/resources.ts'))).toBe(false);
      expect(existsSync(join(out, 'src/prompts.ts'))).toBe(false);
    });
  });

  it('--format python emits server.py + requirements.txt (no Dockerfile for stdio default)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'openapi', SPEC, '-o', out, '--format', 'python'], {
        cwd: dir,
      });

      expect(r.code).toBe(0);
      expect(combined(r)).toContain('Generating python MCP server: swagger-petstore');
      // stdio (default transport) → 3 files, no Dockerfile.
      assertTreeEquals(out, ['.env.example', 'requirements.txt', 'server.py']);
      const server = readFileSync(join(out, 'server.py'), 'utf8');
      expect(server).toContain('from mcp.server.fastmcp import FastMCP');
    });
  });

  it('--format python --transport http adds a Dockerfile alongside server.py', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'openapi', SPEC, '-o', out, '--format', 'python', '--transport', 'http'],
        { cwd: dir },
      );

      expect(r.code).toBe(0);
      // HTTP transport adds the Dockerfile (the only delta vs stdio above).
      assertTreeEquals(out, ['.env.example', 'Dockerfile', 'requirements.txt', 'server.py']);
    });
  });

  it('--force overwrites a hand-edited file; a no-force re-run skips it (exists)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');

      // 1st generation.
      const first = await runCli(['from', 'openapi', SPEC, '-o', out], { cwd: dir });
      expect(first.code).toBe(0);

      // Corrupt a generated file to prove overwrite semantics by content, not just exit code.
      const readme = join(out, 'README.md');
      const SENTINEL = 'SENTINEL_HAND_EDIT_DO_NOT_OVERWRITE';
      const { writeFileSync } = await import('node:fs');
      writeFileSync(readme, SENTINEL);

      // Re-run WITHOUT --force: emitter skips existing files (warns), sentinel survives.
      const noForce = await runCli(['from', 'openapi', SPEC, '-o', out], { cwd: dir });
      expect(noForce.code).toBe(0);
      expect(combined(noForce)).toContain('Skipped (exists): README.md');
      expect(readFileSync(readme, 'utf8')).toBe(SENTINEL);

      // Re-run WITH --force: file is regenerated, sentinel gone.
      const force = await runCli(['from', 'openapi', SPEC, '-o', out, '--force'], { cwd: dir });
      expect(force.code).toBe(0);
      expect(combined(force)).not.toContain('Skipped (exists):');
      expect(readFileSync(readme, 'utf8')).not.toContain(SENTINEL);

      // Tree is unchanged by the overwrite (still the canonical 23-file node tree).
      assertTreeEquals(out, NODE_TREE);
      // Sanity: listTree is deterministic across the two writes.
      expect(listTree(out)).toEqual([...NODE_TREE].sort());
    });
  });
});
