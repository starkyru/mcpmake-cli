import { describe, it, expect } from 'vitest';
import { buildSmokeSuite } from '../../src/verify/smoke-suite.js';
import type { OperationDescriptor, ResponseDescriptor } from '../../src/types/index.js';

function op(partial: Partial<OperationDescriptor>): OperationDescriptor {
  return {
    operationId: 'x',
    method: 'get',
    path: '/x',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...partial,
  };
}

const petObject: ResponseDescriptor = {
  statusCode: '200',
  schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' } } },
};
const petArray: ResponseDescriptor = {
  statusCode: '200',
  schema: { type: 'array', items: { type: 'object', required: ['id'] } },
};

describe('buildSmokeSuite', () => {
  it('emits a case for a read-only op with no required params', () => {
    const suite = buildSmokeSuite([
      op({ operationId: 'listPets', path: '/pets', responses: [petArray] }),
    ]);
    expect(suite.cases).toHaveLength(1);
    expect(suite.cases[0]).toMatchObject({
      name: 'listPets',
      method: 'GET',
      path: '/pets',
      bodyKind: 'array',
      requiredFields: [],
      query: {},
    });
  });

  it('captures top-level required fields for an object body', () => {
    const suite = buildSmokeSuite([
      op({ operationId: 'getPet', path: '/pet', responses: [petObject] }),
    ]);
    expect(suite.cases[0].bodyKind).toBe('object');
    expect(suite.cases[0].requiredFields).toEqual(['id', 'name']);
  });

  it('skips write operations with a reason', () => {
    const suite = buildSmokeSuite([
      op({ operationId: 'createPet', method: 'post', path: '/pets', responses: [petObject] }),
    ]);
    expect(suite.cases).toHaveLength(0);
    expect(suite.skipped).toContainEqual({
      operationId: 'createPet',
      reason: 'write method (read-only suite)',
    });
  });

  it('skips a read-only op whose required path param lacks an example', () => {
    const suite = buildSmokeSuite([
      op({
        operationId: 'showPetById',
        path: '/pets/{petId}',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: [petObject],
      }),
    ]);
    expect(suite.cases).toHaveLength(0);
    expect(suite.skipped[0].operationId).toBe('showPetById');
    expect(suite.skipped[0].reason).toContain('no example for path param "petId"');
  });

  it('substitutes a path-param example into the case path', () => {
    const suite = buildSmokeSuite([
      op({
        operationId: 'showPetById',
        path: '/pets/{petId}',
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'string', example: 'p1' } },
        ],
        responses: [petObject],
      }),
    ]);
    expect(suite.cases[0].path).toBe('/pets/p1');
  });

  it('skips when a required query param has no example', () => {
    const suite = buildSmokeSuite([
      op({
        operationId: 'search',
        path: '/search',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: [petArray],
      }),
    ]);
    expect(suite.cases).toHaveLength(0);
    expect(suite.skipped[0].reason).toContain('required query param "q"');
  });

  it('detects a list -> item chain (GET /pets [array] + GET /pets/{petId})', () => {
    const suite = buildSmokeSuite([
      op({ operationId: 'listPets', path: '/pets', responses: [petArray] }),
      op({
        operationId: 'showPetById',
        path: '/pets/{petId}',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: [petObject],
      }),
    ]);
    expect(suite.chain).toEqual({
      listName: 'listPets',
      listPath: '/pets',
      itemName: 'showPetById',
      itemPathTemplate: '/pets/{petId}',
      idParam: 'petId',
    });
  });

  it('does not detect a chain when the list body is not an array', () => {
    const suite = buildSmokeSuite([
      op({ operationId: 'getPets', path: '/pets', responses: [petObject] }),
      op({
        operationId: 'showPetById',
        path: '/pets/{petId}',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: [petObject],
      }),
    ]);
    expect(suite.chain).toBeUndefined();
  });
});
