/**
 * Sprint E2 — `mcpmake merge` end-to-end.
 *
 * Spawns the built bin. Covers: two disjoint specs with `-o` (exit 0, parsed
 * union written to disk), no `-o` (YAML to stdout), conflicting specs (non-zero
 * exit + exact conflict message for both path and schema collisions), and an
 * identical security scheme merging silently.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { E2E } from './helpers/gating.js';
import type { OpenAPIV3 } from 'openapi-types';

/**
 * The merge command writes the YAML doc to stdout, but `logger.info` also writes
 * to stdout — in the spawned (non-TTY, CI=1) env those lines are prefixed
 * `[info] [mcpmake] ...`. Strip every consola log line (they start with `[`) so
 * what remains is the pure YAML document.
 */
function stripConsolaLines(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !line.startsWith('['))
    .join('\n');
}

const A = fileURLToPath(new URL('./fixtures/merge-a.yaml', import.meta.url));
const B = fileURLToPath(new URL('./fixtures/merge-b.yaml', import.meta.url));
const CONFLICT_PATH = fileURLToPath(
  new URL('./fixtures/merge-conflict-path.yaml', import.meta.url),
);
const SCHEMA_BASE = fileURLToPath(new URL('./fixtures/merge-schema-base.yaml', import.meta.url));
const CONFLICT_SCHEMA = fileURLToPath(
  new URL('./fixtures/merge-conflict-schema.yaml', import.meta.url),
);

describe.skipIf(!E2E)('e2e: mcpmake merge', () => {
  beforeAll(() => ensureBuilt());

  it('two disjoint specs with -o write the parsed union to disk (exit 0)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'merged.yaml');
      const r = await runCli(['merge', A, B, '-o', out]);
      expect(r.code).toBe(0);
      expect(combined(r)).toContain(`Merged spec written to: ${out}`);

      const merged = yamlParse(await readFile(out, 'utf-8')) as OpenAPIV3.Document;
      // Union of both paths, each keeping its own operation.
      expect(Object.keys(merged.paths).sort()).toEqual(['/alpha', '/beta']);
      expect((merged.paths['/alpha'] as OpenAPIV3.PathItemObject).get?.operationId).toBe(
        'getAlpha',
      );
      expect((merged.paths['/beta'] as OpenAPIV3.PathItemObject).post?.operationId).toBe(
        'createBeta',
      );
      // info/servers come from the base (spec A).
      expect(merged.info.title).toBe('Service A');
    });
  });

  it('an identical security scheme merges silently (deduped, no conflict)', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'merged.yaml');
      const r = await runCli(['merge', A, B, '-o', out]);
      expect(r.code).toBe(0);

      const merged = yamlParse(await readFile(out, 'utf-8')) as OpenAPIV3.Document;
      // Both specs declare an identical ApiKeyAuth — it survives exactly once.
      expect(Object.keys(merged.components?.securitySchemes ?? {})).toEqual(['ApiKeyAuth']);
    });
  });

  it('without -o the merged YAML is written to stdout', async () => {
    const r = await runCli(['merge', A, B]);
    expect(r.code).toBe(0);

    // stdout carries the YAML (plus consola info lines); parsing the document
    // back out proves it is well-formed and carries both paths.
    const doc = yamlParse(stripConsolaLines(r.stdout)) as OpenAPIV3.Document;
    expect(Object.keys(doc.paths).sort()).toEqual(['/alpha', '/beta']);
  });

  it('conflicting paths fail non-zero with the exact "Path conflict" message', async () => {
    const r = await runCli(['merge', A, CONFLICT_PATH]);
    expect(r.code).toBe(1);
    expect(combined(r)).toContain('Path conflict: GET /alpha exists in both specs');
  });

  it('conflicting schemas fail non-zero with the exact "Schema conflict" message', async () => {
    const r = await runCli(['merge', SCHEMA_BASE, CONFLICT_SCHEMA]);
    expect(r.code).toBe(1);
    expect(combined(r)).toContain('Schema conflict: "Shared" exists in both specs');
  });
});
