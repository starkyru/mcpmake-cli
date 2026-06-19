import { describe, it, expect } from 'vitest';
import { buildResources } from '../../src/transformer/resource-builder.js';
import type { OperationDescriptor } from '../../src/types/index.js';

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'listItems',
    method: 'get',
    path: '/items',
    tags: ['items'],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

describe('resource-builder', () => {
  it('creates static resource for GET list endpoints', () => {
    const resources = buildResources([makeOp()]);
    expect(resources).toHaveLength(1);
    expect(resources[0].isTemplate).toBeUndefined();
    expect(resources[0].uri).toBe('api://list_items');
  });

  it('creates template resource for parameterized GET endpoints', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getItem',
        path: '/items/{itemId}',
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0].isTemplate).toBe(true);
    expect(resources[0].templateParams).toEqual(['itemId']);
    expect(resources[0].uri).toContain('{itemId}');
  });

  it('ignores non-GET operations', () => {
    const resources = buildResources([makeOp({ method: 'post' })]);
    expect(resources).toHaveLength(0);
  });

  it('handles both list and detail endpoints', () => {
    const resources = buildResources([
      makeOp({ operationId: 'listItems', path: '/items' }),
      makeOp({
        operationId: 'getItem',
        path: '/items/{id}',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    expect(resources).toHaveLength(2);
    expect(resources[0].isTemplate).toBeUndefined();
    expect(resources[1].isTemplate).toBe(true);
  });
});
