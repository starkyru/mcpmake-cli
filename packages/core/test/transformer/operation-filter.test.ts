import { describe, it, expect } from 'vitest';
import { filterOperations } from '../../src/transformer/operation-filter.js';
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

const ops = [
  makeOp({ operationId: 'listPets', path: '/pets', tags: ['pets'] }),
  makeOp({ operationId: 'createPet', method: 'post', path: '/pets', tags: ['pets'] }),
  makeOp({ operationId: 'listUsers', path: '/users', tags: ['users'] }),
  makeOp({ operationId: 'getAdmin', path: '/admin/settings', tags: ['admin'] }),
];

describe('operation-filter', () => {
  it('includes by tag', () => {
    const result = filterOperations(ops, { include: ['pets'] });
    expect(result).toHaveLength(2);
    expect(result.every((op) => op.tags.includes('pets'))).toBe(true);
  });

  it('excludes by tag', () => {
    const result = filterOperations(ops, { exclude: ['admin'] });
    expect(result).toHaveLength(3);
    expect(result.some((op) => op.tags.includes('admin'))).toBe(false);
  });

  it('includes by path glob', () => {
    const result = filterOperations(ops, { include: ['/admin*'] });
    expect(result).toHaveLength(1);
    expect(result[0].operationId).toBe('getAdmin');
  });

  it('includes by operationId substring', () => {
    const result = filterOperations(ops, { include: ['list'] });
    expect(result).toHaveLength(2);
  });

  it('combines include and exclude', () => {
    const result = filterOperations(ops, {
      include: ['pets'],
      exclude: ['create'],
    });
    expect(result).toHaveLength(1);
    expect(result[0].operationId).toBe('listPets');
  });

  it('returns all when no filters', () => {
    const result = filterOperations(ops, {});
    expect(result).toHaveLength(4);
  });

  it('case insensitive matching', () => {
    const result = filterOperations(ops, { include: ['PETS'] });
    expect(result).toHaveLength(2);
  });
});
