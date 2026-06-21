/**
 * Unit tests for the mergePathItemParameters helper exported from merge.ts.
 *
 * The helper is the same function production uses inside mergeSpecs — we test
 * the real export, not a local replica.  If the production implementation is
 * deleted or its logic changes, these tests will catch the regression.
 */

import { describe, it, expect } from 'vitest';
import { mergePathItemParameters } from '../../src/commands/merge.js';
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
