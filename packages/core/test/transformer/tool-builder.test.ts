import { describe, it, expect } from 'vitest';
import { buildToolDefinition, buildAllTools } from '../../src/transformer/tool-builder.js';
import type { OperationDescriptor } from '../../src/types/index.js';

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'listPets',
    method: 'get',
    path: '/pets',
    tags: ['pets'],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

describe('tool-builder', () => {
  describe('buildToolDefinition', () => {
    it('generates correct tool name and title', () => {
      const tool = buildToolDefinition(makeOp());
      expect(tool.name).toBe('list_pets');
      expect(tool.title).toBe('List Pets');
    });

    it('uses summary as description', () => {
      const tool = buildToolDefinition(makeOp({ summary: 'List all pets' }));
      expect(tool.description).toBe('List all pets');
    });

    it('marks deprecated operations', () => {
      const tool = buildToolDefinition(makeOp({ summary: 'Old endpoint', deprecated: true }));
      expect(tool.description).toContain('[DEPRECATED]');
    });

    it('extracts path and query params', () => {
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'showPetById',
          path: '/pets/{petId}',
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'fields', in: 'query', required: false, schema: { type: 'string' } },
          ],
        }),
      );
      expect(tool.pathParams).toEqual(['petId']);
      expect(tool.queryParams).toEqual(['fields']);
    });

    it('detects request body', () => {
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'createPet',
          method: 'post',
          requestBody: {
            required: true,
            contentType: 'application/json',
            schema: { type: 'object' },
          },
        }),
      );
      expect(tool.hasRequestBody).toBe(true);
      expect(tool.requestBodyContentType).toBe('application/json');
    });

    it('generates buildUrlBody with path params', () => {
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'showPetById',
          path: '/pets/{petId}',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      );
      expect(tool.buildUrlBody).toContain("replace('{petId}'");
      expect(tool.buildUrlBody).toContain('encodeURIComponent');
    });

    it('generates buildUrlBody with query params', () => {
      const tool = buildToolDefinition(
        makeOp({
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          ],
        }),
      );
      expect(tool.buildUrlBody).toContain('URLSearchParams');
      expect(tool.buildUrlBody).toContain("'limit'");
    });
  });

  describe('buildAllTools', () => {
    it('handles name collisions by appending method', () => {
      const ops = [
        makeOp({ operationId: 'pets', method: 'get', path: '/pets' }),
        makeOp({ operationId: 'pets', method: 'post', path: '/pets' }),
      ];
      const tools = buildAllTools(ops);
      expect(tools[0].name).toBe('pets_get');
      expect(tools[1].name).toBe('pets_post');
    });

    it('preserves unique names', () => {
      const ops = [
        makeOp({ operationId: 'listPets' }),
        makeOp({ operationId: 'createPet', method: 'post' }),
      ];
      const tools = buildAllTools(ops);
      expect(tools[0].name).toBe('list_pets');
      expect(tools[1].name).toBe('create_pet');
    });
  });
});
