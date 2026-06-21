import { describe, it, expect } from 'vitest';
import {
  jsonSchemaToZodCode,
  jsonSchemaToOutputZodCode,
  wrapArrayRoot,
  buildOperationInputSchema,
} from '../../src/parser/schema-converter.js';
import type { OperationDescriptor } from '../../src/types/index.js';

describe('schema quality', () => {
  describe('circular reference handling', () => {
    // A 1s per-test timeout makes the "does not hang / no infinite recursion"
    // property explicit: if the depth/cycle guards were removed the conversion
    // would recurse forever (or blow the stack) and the test would fail by
    // timeout rather than silently passing.
    it('truncates deeply nested schemas at MAX_SCHEMA_DEPTH', () => {
      // 20 levels of nesting > MAX_SCHEMA_DEPTH (15), so the deepest levels
      // must be replaced with the depth-truncation marker.
      let schema: any = { type: 'string' };
      for (let i = 0; i < 20; i++) {
        schema = { type: 'object', properties: { nested: schema } };
      }
      const code = jsonSchemaToZodCode(schema);

      // The depth limiter must fire and leave its marker in the output.
      expect(code).toContain('Truncated: max depth exceeded');
      // It must NOT have fallen into the catch-all error path (which would
      // mean the depth logic threw instead of truncating gracefully).
      expect(code).not.toBe('z.any()');
      // Real conversion still happened: the outer object structure survives.
      expect(code).toContain('z.object');
      expect(code).toContain('"nested"');

      // Truncation should occur deep in the tree, not at the surface: the
      // first MAX_SCHEMA_DEPTH levels are real z.object wrappers preceding
      // the marker. (16 wrappers expand before truncation at depth 16.)
      const wrappersBeforeMarker =
        code.slice(0, code.indexOf('Truncated: max depth exceeded')).split('z.object').length - 1;
      expect(wrappersBeforeMarker).toBeGreaterThanOrEqual(15);
    }, 1000);

    it('replaces self-referencing back-edges with a circular-reference marker', () => {
      const schema: any = { type: 'object', properties: {} };
      schema.properties.self = schema; // back-edge to the root (true cycle)

      const code = jsonSchemaToZodCode(schema);

      // The back-edge must be detected and surfaced as the documented marker
      // rather than recursing forever or being silently dropped.
      expect(code).toContain('Truncated: circular reference');
      // Must not regress to the old broken behavior of returning the
      // catch-all z.any() for any schema it cannot handle.
      expect(code).not.toBe('z.any()');
      // The self-referencing property is preserved (just truncated), not lost.
      expect(code).toContain('"self"');
      expect(code).toContain('z.object');
    }, 1000);
  });

  describe('array root wrapping', () => {
    it('wraps bare array in object', () => {
      const wrapped = wrapArrayRoot({ type: 'array', items: { type: 'string' } });
      expect(wrapped.type).toBe('object');
      expect((wrapped.properties as any).items.type).toBe('array');
    });

    it('leaves object schemas unchanged', () => {
      const schema = { type: 'object', properties: { name: { type: 'string' } } };
      expect(wrapArrayRoot(schema)).toEqual(schema);
    });

    it('outputSchema wraps arrays', () => {
      const code = jsonSchemaToOutputZodCode({
        type: 'array',
        items: { type: 'string' },
      });
      expect(code).toContain('z.object');
      expect(code).toContain('items');
    });
  });

  describe('parameter collision resolution', () => {
    it('renames colliding params with location suffix', () => {
      const op: OperationDescriptor = {
        operationId: 'test',
        method: 'get',
        path: '/test/{id}',
        tags: [],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: [],
        security: [],
        deprecated: false,
      };
      const { code } = buildOperationInputSchema(op);
      // Keys are JSON.stringify'd (D-H1); the second `id` is disambiguated by
      // its location so both params remain addressable.
      expect(code).toContain('"id":');
      expect(code).toContain('"id_query":');
    });
  });
});
