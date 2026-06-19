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
    it('truncates deeply nested schemas', () => {
      // Create a schema that would be very deep
      let schema: any = { type: 'string' };
      for (let i = 0; i < 20; i++) {
        schema = { type: 'object', properties: { nested: schema } };
      }
      const code = jsonSchemaToZodCode(schema);
      expect(code).toBeDefined();
      // Should not throw or hang
    });

    it('handles self-referencing objects gracefully', () => {
      const schema: any = { type: 'object', properties: {} };
      schema.properties.self = schema; // circular
      const code = jsonSchemaToZodCode(schema);
      expect(code).toBeDefined();
    });
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
      const code = buildOperationInputSchema(op);
      expect(code).toContain('id:');
      expect(code).toContain('id_query:');
    });
  });
});
