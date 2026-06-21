/**
 * Sprint E2 — `mcpmake lint` end-to-end.
 *
 * Spawns the built bin against real OpenAPI specs and asserts exit codes, the
 * exact `--format json` shape ({level,rule,tool,message}), level filtering, and
 * the failure paths (errors → exit 1; no operations → exit 1). Fixtures live in
 * ./fixtures and are hand-built to land one finding at each level.
 */

import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { E2E } from './helpers/gating.js';

/** A clean spec that shares the petstore fixture used across the suite. */
const PETSTORE = fileURLToPath(new URL('../fixtures/petstore.yaml', import.meta.url));
/** Adversarial spec: one error + one warn + one info finding. */
const RESERVED = fileURLToPath(new URL('./fixtures/lint-reserved.yaml', import.meta.url));
/** Spec with `paths: {}` — no operations at all. */
const EMPTY_PATHS = fileURLToPath(new URL('./fixtures/lint-empty-paths.yaml', import.meta.url));

interface LintFinding {
  level: 'error' | 'warn' | 'info';
  rule: string;
  tool: string;
  message: string;
}

/**
 * Pull the JSON array out of stdout. `logger.info` also writes to stdout, and in
 * the spawned (non-TTY, CI=1) env consola prefixes those lines `[info] [mcpmake]
 * ...`, so we can't `JSON.parse` the whole stream. The lint command prints a
 * JSON *array* via `JSON.stringify(..., 2)`, whose opening bracket sits on its
 * own line (`[\n`) — or is the empty `[]`. Consola log lines are `[` followed by
 * a word char (`[info]`, `[error]`, …). So the first `[` whose next char is a
 * newline or `]` begins the JSON.
 */
function extractJsonArray<T>(stdout: string): T {
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === '[' && (stdout[i + 1] === '\n' || stdout[i + 1] === ']')) {
      return JSON.parse(stdout.slice(i)) as T;
    }
  }
  throw new Error(`no JSON array found in stdout:\n${stdout}`);
}

describe.skipIf(!E2E)('e2e: mcpmake lint', () => {
  beforeAll(() => ensureBuilt());

  it('a spec with no errors exits 0', async () => {
    // Petstore yields only one INFO finding (missing-annotations); the exit code
    // is driven solely by error-level findings, so a no-error spec exits clean.
    const r = await runCli(['lint', PETSTORE]);
    expect(r.code).toBe(0);
  });

  it('--format json prints an array of {level,rule,tool,message} objects', async () => {
    const r = await runCli(['lint', PETSTORE, '--format', 'json']);
    expect(r.code).toBe(0);

    const findings = extractJsonArray<LintFinding[]>(r.stdout);
    expect(Array.isArray(findings)).toBe(true);
    // Petstore's lone finding is the create_pet missing-annotations INFO.
    expect(findings).toEqual([
      {
        level: 'info',
        rule: 'missing-annotations',
        tool: 'create_pet',
        message: 'No readOnlyHint/destructiveHint annotations set — consider adding for safety',
      },
    ]);
  });

  it('an adversarial spec with a reserved tool name exits 1 and reports the error', async () => {
    const r = await runCli(['lint', RESERVED, '--format', 'json']);
    expect(r.code).toBe(1);

    const findings = extractJsonArray<LintFinding[]>(r.stdout);
    // Exactly three findings, one per level, in declaration order.
    expect(findings).toEqual([
      {
        level: 'error',
        rule: 'reserved-names',
        tool: 'ping',
        message: '"ping" conflicts with MCP built-in method name',
      },
      {
        level: 'warn',
        rule: 'tool-name-length',
        tool: 'create_widget_with_an_exceedingly_verbose_and_overly_descriptive_long_operation_identifier_name',
        message: 'Name is 95 chars — exceeds Cursor limit of 60',
      },
      {
        level: 'info',
        rule: 'missing-annotations',
        tool: 'create_widget_with_an_exceedingly_verbose_and_overly_descriptive_long_operation_identifier_name',
        message: 'No readOnlyHint/destructiveHint annotations set — consider adding for safety',
      },
    ]);
  });

  it('--level error filters out warn and info findings', async () => {
    const r = await runCli(['lint', RESERVED, '--format', 'json', '--level', 'error']);
    // Still exits 1 (the error is still present, just the only thing shown).
    expect(r.code).toBe(1);

    const findings = extractJsonArray<LintFinding[]>(r.stdout);
    expect(findings).toEqual([
      {
        level: 'error',
        rule: 'reserved-names',
        tool: 'ping',
        message: '"ping" conflicts with MCP built-in method name',
      },
    ]);
    // Discriminating: no warn/info leaked through the filter.
    expect(findings.some((f) => f.level === 'warn' || f.level === 'info')).toBe(false);
  });

  it('a spec with no operations fails with "No operations found"', async () => {
    const r = await runCli(['lint', EMPTY_PATHS]);
    expect(r.code).toBe(1);
    expect(combined(r)).toContain('No operations found in the spec.');
  });
});
