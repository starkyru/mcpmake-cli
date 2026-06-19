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

      const code = buildOperationInputSchema(op);
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

      const code = buildOperationInputSchema(op);
      expect(code).toContain('body:');
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

      const code = buildOperationInputSchema(op);
      expect(code).toBe('z.object({})');
    });

    it('skips header params', () => {
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

      const code = buildOperationInputSchema(op);
      expect(code).toBe('z.object({})');
    });
  });
});
