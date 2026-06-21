/**
 * R12-A regression: discovery.ts execute_tool must read the request body from
 * `args[tool.bodyInputKey]` (dynamic key) rather than the hardcoded `args.body`.
 * Also verifies that the emitted CatalogEntry interface declares `bodyInputKey`.
 *
 * R14-A regression: execute_tool must read path/query args by `p.inputKey` and
 * send them upstream under `p.wireName`, not by a bare wire-name string, so that
 * parameter name collisions (e.g. query `id` exposed as `id_query`) are handled
 * correctly.
 */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { renderTemplate } from '../../src/emitter/template-loader.js';

/** Transpile rendered TS and assert no syntax errors. */
function assertParses(source: string, label: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const syntactic = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  const msgs = syntactic
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    .join('; ');
  expect(syntactic, `${label} did not parse: ${msgs}`).toHaveLength(0);
}

const src = renderTemplate('discovery.ts', {});

describe('R12-A: discovery.ts dynamic body key', () => {
  it('renders parseable TypeScript', () => {
    assertParses(src, 'discovery.ts');
  });

  it('does NOT hardcode args.body in execute_tool', () => {
    // The old broken pattern. Any remaining occurrence would be the bug.
    expect(src).not.toContain('args.body');
  });

  it('uses args[bodyKey] with a fallback-guarded key variable', () => {
    // Must derive the body key from tool.bodyInputKey with a fallback.
    expect(src).toMatch(/bodyKey\s*=\s*tool\.bodyInputKey\s*\?\?\s*['"]body['"]/);
    expect(src).toContain('args[bodyKey]');
  });

  it('declares bodyInputKey on the local CatalogEntry interface', () => {
    // The emitted interface must carry the field so tool.bodyInputKey typechecks.
    expect(src).toMatch(/bodyInputKey\?\s*:\s*string/);
  });

  it('gates body inclusion on hasRequestBody AND args[bodyKey] !== undefined', () => {
    // Ensures we don't send a body when none was provided, and don't regress the
    // hasRequestBody gate that was already present.
    expect(src).toContain('tool.hasRequestBody');
    expect(src).toContain('args[bodyKey] !== undefined');
  });
});

describe('R14-A: discovery.ts inputKey/wireName split for path and query params', () => {
  it('renders parseable TypeScript (re-check after R14-A edits)', () => {
    assertParses(src, 'discovery.ts (R14-A)');
  });

  it('declares CatalogParamMapping interface with inputKey and wireName', () => {
    // The emitted source must define the mapping shape used by pathParams/queryParams.
    expect(src).toMatch(/interface\s+CatalogParamMapping/);
    expect(src).toMatch(/inputKey\s*:\s*string/);
    expect(src).toMatch(/wireName\s*:\s*string/);
  });

  it('declares pathParams and queryParams as CatalogParamMapping[] in CatalogEntry', () => {
    expect(src).toMatch(/pathParams\s*:\s*CatalogParamMapping\[\]/);
    expect(src).toMatch(/queryParams\s*:\s*CatalogParamMapping\[\]/);
  });

  it('does NOT read path params by bare string variable (old pattern)', () => {
    // Old: `for (const param of tool.pathParams) { ... args[param] ... }`
    // The loop variable must not be a bare `param` anymore.
    expect(src).not.toMatch(/args\[param\]/);
  });

  it('reads path args by p.inputKey and substitutes p.wireName into the URL', () => {
    // New path-substitution pattern.
    expect(src).toContain('args[p.inputKey]');
    expect(src).toContain('p.wireName');
  });

  it('sets query params under p.wireName using args[p.inputKey]', () => {
    // New query-build pattern: read inputKey, send wireName.
    expect(src).toMatch(/queryParams\.set\(p\.wireName,\s*String\(args\[p\.inputKey\]\)\)/);
  });
});
