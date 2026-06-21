/**
 * Unit tests for the mergePathItemParameters helper exported from merge.ts.
 *
 * The helper is the same function production uses inside mergeSpecs — we test
 * the real export, not a local replica.  If the production implementation is
 * deleted or its logic changes, these tests will catch the regression.
 */

import { describe, it, expect } from 'vitest';
import { mergePathItemParameters, mergeSpecs } from '../../src/commands/merge.js';
import type { OpenAPIV3 } from 'openapi-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParam(name: string, inLoc: string): OpenAPIV3.ParameterObject {
  return { name, in: inLoc } as OpenAPIV3.ParameterObject;
}

// ---------------------------------------------------------------------------
// R13-B: path-level parameters merge (deduplication by name+in)
// ---------------------------------------------------------------------------

describe('mergeSpecs — path-level parameters (R13-B)', () => {
  it('keeps both params when base and other have disjoint path-level params', () => {
    const baseParams = [makeParam('userId', 'path')];
    const otherParams = [makeParam('format', 'query')];

    const merged = mergePathItemParameters(baseParams, otherParams);

    expect(merged).toHaveLength(2);
    expect(merged.find((p) => p.name === 'userId')).toBeDefined();
    expect(merged.find((p) => p.name === 'format')).toBeDefined();
  });

  it('deduplicates by (name, in): keeps base entry on a tie', () => {
    const baseParam = {
      name: 'shared',
      in: 'query',
      description: 'from base',
    } as OpenAPIV3.ParameterObject;
    const otherParam = {
      name: 'shared',
      in: 'query',
      description: 'from other',
    } as OpenAPIV3.ParameterObject;

    const merged = mergePathItemParameters([baseParam], [otherParam]);

    expect(merged).toHaveLength(1);
    expect((merged[0] as OpenAPIV3.ParameterObject & { description?: string }).description).toBe(
      'from base',
    );
  });

  it('treats (name, in) as the composite key — same name in different locations are kept separately', () => {
    const baseParam = makeParam('id', 'path');
    const otherParam = makeParam('id', 'query');

    const merged = mergePathItemParameters([baseParam], [otherParam]);

    expect(merged).toHaveLength(2);
    expect(merged.filter((p) => p.name === 'id')).toHaveLength(2);
  });

  it('handles empty base params — returns all other params', () => {
    const otherParams = [makeParam('page', 'query'), makeParam('limit', 'query')];

    const merged = mergePathItemParameters([], otherParams);

    expect(merged).toHaveLength(2);
    expect(merged.map((p) => p.name).sort()).toEqual(['limit', 'page']);
  });

  it('handles empty other params — returns all base params unchanged', () => {
    const baseParams = [makeParam('tenantId', 'path')];

    const merged = mergePathItemParameters(baseParams, []);

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('tenantId');
  });

  it('handles both empty — returns empty', () => {
    expect(mergePathItemParameters([], [])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R22-5: null path-item guard in mergeSpecs
// ---------------------------------------------------------------------------

function makeMinimalSpec(
  paths: Record<string, OpenAPIV3.PathItemObject | null>,
): OpenAPIV3.Document {
  return {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: paths as OpenAPIV3.PathsObject,
  };
}

describe('mergeSpecs — null path-item guard (R22-5)', () => {
  it('does not throw when other spec has a null path item for a shared path; keeps base path item', () => {
    const base = makeMinimalSpec({
      '/x': { get: { responses: { '200': { description: 'ok' } } } },
    });
    const other = makeMinimalSpec({
      '/x': null,
    });

    let merged: OpenAPIV3.Document;
    expect(() => {
      merged = mergeSpecs(base, other);
    }).not.toThrow();

    // null in other → keep base path item
    expect(merged!.paths['/x']).toBeDefined();
    const pathItem = merged!.paths['/x'] as OpenAPIV3.PathItemObject;
    expect(pathItem.get).toBeDefined();
  });

  it('does not throw when base spec has a null path item for a shared path; keeps other path item', () => {
    const base = makeMinimalSpec({ '/x': null });
    const other = makeMinimalSpec({
      '/x': { post: { responses: { '201': { description: 'created' } } } },
    });

    let merged: OpenAPIV3.Document;
    expect(() => {
      merged = mergeSpecs(base, other);
    }).not.toThrow();

    // null in base → keep other path item
    const pathItem = merged!.paths['/x'] as OpenAPIV3.PathItemObject;
    expect(pathItem.post).toBeDefined();
  });

  it('does not throw when both specs have a null path item for the same path', () => {
    const base = makeMinimalSpec({ '/x': null });
    const other = makeMinimalSpec({ '/x': null });

    expect(() => mergeSpecs(base, other)).not.toThrow();
  });

  it('still throws on a real method conflict when both path items are non-null', () => {
    const base = makeMinimalSpec({
      '/x': { get: { responses: { '200': { description: 'ok' } } } },
    });
    const other = makeMinimalSpec({
      '/x': { get: { responses: { '200': { description: 'also ok' } } } },
    });

    expect(() => mergeSpecs(base, other)).toThrow(/Path conflict/);
  });
});
