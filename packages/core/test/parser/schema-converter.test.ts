import { describe, it, expect } from 'vitest';
import {
  jsonSchemaToZodCode,
  buildOperationInputSchema,
} from '../../src/parser/schema-converter.js';
import type { OperationDescriptor } from '../../src/types/index.js';

describe('schema-converter', () => {
  describe('jsonSchemaToZodCode', () => {
    it('converts a simple string schema', () => {
      const code = jsonSchemaToZodCode({ type: 'string' });
      expect(code).toContain('z.string()');
    });

    it('converts an object schema with required fields', () => {
      const code = jsonSchemaToZodCode({
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
      });
      expect(code).toContain('z.object');
      expect(code).toContain('name');
      expect(code).toContain('age');
    });

    it('returns z.any() for invalid schemas', () => {
      const code = jsonSchemaToZodCode({ type: 'invalid-type' as any });
      expect(code).toContain('z.any()');
    });

    it('fully expands a shared (diamond) subschema under sibling properties (M2)', () => {
      // After $ref dereferencing, the same component object is reused by two
      // sibling properties — a DAG/diamond, not a cycle. Both must keep their
      // full fields; neither may be truncated as "circular".
      const shared = {
        type: 'object',
        properties: {
          uniqueFieldA: { type: 'string' },
          uniqueFieldB: { type: 'number' },
        },
      } as any;
      const code = jsonSchemaToZodCode({
        type: 'object',
        properties: {
          first: shared,
          second: shared,
        },
      });
      // Both siblings retain every field — the second is not flagged circular.
      expect(code).not.toContain('circular reference');
      expect(code.match(/uniqueFieldA/g)?.length).toBe(2);
      expect(code.match(/uniqueFieldB/g)?.length).toBe(2);
    });

    it('drops `default: null` on a non-nullable array (docker-engine SystemInfo)', () => {
      const code = jsonSchemaToZodCode({
        type: 'array',
        items: { type: 'string' },
        default: null,
      } as any);
      expect(code).toBe('z.array(z.string())');
    });

    it('drops a string default on an array type (openai Eval.testing_criteria)', () => {
      const code = jsonSchemaToZodCode({
        type: 'array',
        items: { type: 'string' },
        default: 'eval',
      } as any);
      expect(code).toBe('z.array(z.string())');
    });

    it('drops an array default on a string enum (openai TranscriptionInclude)', () => {
      const code = jsonSchemaToZodCode({
        type: 'string',
        enum: ['logprobs'],
        default: [],
      } as any);
      expect(code).toBe('z.literal("logprobs")');
    });

    it('drops a default that is not a member of the enum', () => {
      const code = jsonSchemaToZodCode({
        type: 'string',
        enum: ['a', 'b'],
        default: 'c',
      } as any);
      expect(code).toBe('z.enum(["a","b"])');
    });

    it('keeps a coherent default', () => {
      const code = jsonSchemaToZodCode({
        type: 'array',
        items: { type: 'string' },
        default: [],
      } as any);
      expect(code).toBe('z.array(z.string()).default([])');
    });

    it('keeps `default: null` on a nullable schema, hoisted onto the union', () => {
      const code = jsonSchemaToZodCode({
        type: 'string',
        nullable: true,
        default: null,
      } as any);
      // nullable → oneOf union; the null default survives on the wrapper.
      expect(code).toContain('.default(null)');
      expect(code).toContain('z.null()');
    });

    it('sanitizes garbage defaults nested inside anyOf branches', () => {
      const code = jsonSchemaToZodCode({
        anyOf: [
          { type: 'array', items: { type: 'string' }, default: 'bogus' },
          { type: 'null' },
        ],
      } as any);
      expect(code).not.toContain('.default("bogus")');
    });

    it('bounds expansion of a heavily-shared schema DAG (stripe OOM)', () => {
      // Build a DAG whose FULL expansion is 4^10 > 1M nodes but whose document
      // is tiny: each layer's node is referenced by 4 properties of the layer
      // above (the shape of stripe's customer/charge/subscription web after
      // dereferencing). Without a node budget this either OOMs or emits
      // megabytes of zod code.
      let layer: any = { type: 'string' };
      for (let i = 0; i < 10; i++) {
        layer = {
          type: 'object',
          properties: { a: layer, b: layer, c: layer, d: layer },
        };
      }
      const code = jsonSchemaToZodCode(layer);
      // Bounded output: the budget (2000 nodes) keeps the code in the tens of
      // KB, and over-budget subtrees degrade to the permissive record form.
      expect(code.length).toBeLessThan(200_000);
      expect(code).toContain('Truncated: schema too large');
      expect(code).toContain('z.record(z.any())');
    });

    it('does not truncate a schema within the node budget', () => {
      const code = jsonSchemaToZodCode({
        type: 'object',
        properties: {
          name: { type: 'string' },
          nested: { type: 'object', properties: { id: { type: 'integer' } } },
        },
      });
      expect(code).not.toContain('Truncated');
      expect(code).toContain('z.number().int()');
    });

    it('terminates on a truly self-referential schema without stack overflow (M2)', () => {
      // A real back-edge to an ancestor must still be cut so recursion bounds.
      const node: any = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };
      node.properties.self = node; // self-reference (back-edge to ancestor)
      expect(() => jsonSchemaToZodCode(node)).not.toThrow();
      const code = jsonSchemaToZodCode(node);
      expect(code).toContain('circular reference');
    });
  });

  describe('buildOperationInputSchema', () => {
    it('builds schema from path and query params', () => {
      const op: OperationDescriptor = {
        operationId: 'getUser',
        method: 'get',
        path: '/users/{userId}',
        tags: [],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            description: 'The user ID',
            schema: { type: 'string' },
          },
          {
            name: 'fields',
            in: 'query',
            required: false,
            description: 'Fields to include',
            schema: { type: 'string' },
          },
        ],
        responses: [],
        security: [],
        deprecated: false,
      };

      const { code } = buildOperationInputSchema(op);
      expect(code).toContain('z.object');
      expect(code).toContain('userId');
      expect(code).toContain('fields');
      expect(code).toContain('.optional()');
      expect(code).toContain('.describe(');
    });

    it('includes request body under body key', () => {
      const op: OperationDescriptor = {
        operationId: 'createUser',
        method: 'post',
        path: '/users',
        tags: [],
        parameters: [],
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
        },
        responses: [],
        security: [],
        deprecated: false,
      };

      const { code } = buildOperationInputSchema(op);
      // Keys are JSON.stringify'd so any name is a legal TS object key (D-H1).
      expect(code).toContain('"body":');
    });

    it('returns empty object schema for no params', () => {
      const op: OperationDescriptor = {
        operationId: 'healthCheck',
        method: 'get',
        path: '/health',
        tags: [],
        parameters: [],
        responses: [],
        security: [],
        deprecated: false,
      };

      const { code } = buildOperationInputSchema(op);
      expect(code).toBe('z.object({})');
    });

    it('exposes header params and maps them to their wire name (D-H2)', () => {
      const op: OperationDescriptor = {
        operationId: 'getData',
        method: 'get',
        path: '/data',
        tags: [],
        parameters: [
          {
            name: 'X-Request-Id',
            in: 'header',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: [],
        security: [],
        deprecated: false,
      };

      const { code, mappings } = buildOperationInputSchema(op);
      // Header params are no longer dropped from the schema; the key is
      // JSON.stringify'd so a name with a hyphen is still legal TS.
      expect(code).toContain('"X-Request-Id":');
      // A4-H2 enriched each mapping with required/schema/description; pin the
      // load-bearing identity fields via objectContaining and assert the new
      // metadata explicitly so the threading is covered.
      expect(mappings).toContainEqual(
        expect.objectContaining({
          inputKey: 'X-Request-Id',
          wireName: 'X-Request-Id',
          in: 'header',
          required: false,
          schema: { type: 'string' },
        }),
      );
    });

    it('uses a unique body key when both "body" and "requestBody" params exist (R11-D)', () => {
      // An operation whose parameter list already contains params named "body"
      // AND "requestBody" must not produce a duplicate key in the emitted
      // z.object({...}) literal. The body should fall through to "requestBody_2".
      const op: OperationDescriptor = {
        operationId: 'edgeCase',
        method: 'post',
        path: '/edge',
        tags: [],
        parameters: [
          { name: 'body', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'requestBody', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: { type: 'object', properties: { x: { type: 'number' } } },
        },
        responses: [],
        security: [],
        deprecated: false,
      };

      const { code, mappings, bodyInputKey } = buildOperationInputSchema(op);

      // The schema must contain exactly three distinct keys.
      expect(code).toContain('"body":');
      expect(code).toContain('"requestBody":');
      expect(code).toContain('"requestBody_2":');

      // bodyInputKey is the uniquified key emitted into the schema.
      expect(bodyInputKey).toBe('requestBody_2');

      // The two params keep their own keys in the mappings.
      expect(mappings.map((m) => m.inputKey)).toEqual(['body', 'requestBody']);

      // No duplicate key in the source string (each key appears exactly once).
      expect((code.match(/"body":/g) ?? []).length).toBe(1);
      expect((code.match(/"requestBody":/g) ?? []).length).toBe(1);
      expect((code.match(/"requestBody_2":/g) ?? []).length).toBe(1);
    });

    it('emits hyphenated / digit-leading param names as valid TS keys (D-H1)', () => {
      const op: OperationDescriptor = {
        operationId: 'list',
        method: 'get',
        path: '/list',
        tags: [],
        parameters: [
          { name: 'page-size', in: 'query', required: false, schema: { type: 'integer' } },
          { name: '2fa', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: [],
        security: [],
        deprecated: false,
      };

      const { code, mappings } = buildOperationInputSchema(op);
      // Unquoted `page-size:` / `2fa:` would be a syntax error; JSON.stringify'd
      // keys are legal and the original wire name is preserved for the request.
      expect(code).toContain('"page-size":');
      expect(code).toContain('"2fa":');
      expect(mappings.map((m) => m.wireName)).toEqual(['page-size', '2fa']);
    });
  });
});
