/**
 * Sprint E2 — `mcpmake diff` end-to-end.
 *
 * Spawns the built bin to compare two specs. Asserts the exact `--format json`
 * shape ({added,removed,changed,unchanged}) across add/remove/modify, the
 * all-empty self-vs-self delta, the ANSI-stripped text summary, and the
 * invariant that diff ALWAYS exits 0 — even when the specs differ.
 */

import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { E2E } from './helpers/gating.js';

const PETSTORE = fileURLToPath(new URL('../fixtures/petstore.yaml', import.meta.url));
const V1 = fileURLToPath(new URL('./fixtures/diff-v1.yaml', import.meta.url));
const V2 = fileURLToPath(new URL('./fixtures/diff-v2.yaml', import.meta.url));

interface DiffChange {
  field: string;
  old: string;
  new: string;
}
interface DiffJson {
  added: string[];
  removed: string[];
  changed: Array<{ tool: string; changes: DiffChange[] }>;
  unchanged: number;
}

/**
 * Extract the JSON *object* from stdout. The diff command prints
 * `JSON.stringify({...}, 2)`, whose `{` opens on its own line; the consola
 * `[info] [mcpmake] ...` log lines never contain a `{`. So the first `{` begins
 * the JSON value.
 */
function extractJsonObject<T>(stdout: string): T {
  const i = stdout.indexOf('{');
  if (i === -1) throw new Error(`no JSON object found in stdout:\n${stdout}`);
  return JSON.parse(stdout.slice(i)) as T;
}

describe.skipIf(!E2E)('e2e: mcpmake diff', () => {
  beforeAll(() => ensureBuilt());

  it('--format json reports added/removed/changed/unchanged across all delta kinds', async () => {
    const r = await runCli(['diff', V1, V2, '--format', 'json']);
    expect(r.code).toBe(0);

    const d = extractJsonObject<DiffJson>(r.stdout);
    expect(d.added).toEqual(['list_owners']);
    expect(d.removed).toEqual(['delete_pet']);
    expect(d.unchanged).toBe(0);

    // Exactly one changed tool, with the two specific field changes.
    expect(d.changed).toEqual([
      {
        tool: 'list_pets',
        changes: [
          {
            field: 'description',
            old: 'List all pets in the store catalog',
            new: 'List every pet plus pagination support added later',
          },
          {
            field: 'parameters (added)',
            old: '',
            new: 'limit',
          },
        ],
      },
    ]);
  });

  it('self-vs-self produces all-empty deltas', async () => {
    const r = await runCli(['diff', PETSTORE, PETSTORE, '--format', 'json']);
    expect(r.code).toBe(0);

    const d = extractJsonObject<DiffJson>(r.stdout);
    expect(d).toEqual({
      added: [],
      removed: [],
      changed: [],
      unchanged: 4, // petstore has 4 operations → 4 tools, all unchanged
    });
  });

  it('text output (ANSI-stripped) prints the per-section + summary lines', async () => {
    const r = await runCli(['diff', V1, V2]);
    expect(r.code).toBe(0);

    const out = combined(r);
    expect(out).toContain('+ 1 added tool(s):');
    expect(out).toContain('+ list_owners (GET /owners)');
    expect(out).toContain('- 1 removed tool(s):');
    expect(out).toContain('- delete_pet (DELETE /pets/{petId})');
    expect(out).toContain('~ 1 changed tool(s):');
    expect(out).toContain('~ list_pets');
    // The summary tallies all four buckets (added+removed+changed+unchanged=3).
    expect(out).toContain('Summary: 3 tools total — 1 added, 1 removed, 1 changed, 0 unchanged');
  });

  it('always exits 0 even when the two specs differ', async () => {
    // diff is a report, not a gate: a non-zero exit would break informational CI
    // pipelines that run it. Assert exit 0 in both the differing and identical
    // cases so a future "fail on drift" regression is caught.
    const differ = await runCli(['diff', V1, V2]);
    expect(differ.code).toBe(0);

    const same = await runCli(['diff', PETSTORE, PETSTORE]);
    expect(same.code).toBe(0);
  });
});
