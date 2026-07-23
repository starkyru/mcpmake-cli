import { describe, it, expect } from 'vitest';
import { checkResponseShape } from '../../src/verify/shape-check.js';

describe('checkResponseShape', () => {
  it('returns no divergences when an object matches its schema', () => {
    const schema = {
      type: 'object',
      required: ['id', 'name'],
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
    };
    expect(checkResponseShape({ id: 1, name: 'rex' }, schema)).toEqual([]);
  });

  it('flags a missing required property at its path', () => {
    const schema = {
      type: 'object',
      required: ['id', 'name'],
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
    };
    const out = checkResponseShape({ id: 1 }, schema);
    expect(out).toEqual([
      { path: '$.name', kind: 'missing-required', expected: 'present', actual: 'absent' },
    ]);
  });

  it('flags a type mismatch with expected/actual types', () => {
    const schema = { type: 'object', properties: { id: { type: 'integer' } } };
    const out = checkResponseShape({ id: 'nope' }, schema);
    expect(out).toEqual([
      { path: '$.id', kind: 'type-mismatch', expected: 'integer', actual: 'string' },
    ]);
  });

  it('ignores extra properties the response adds', () => {
    const schema = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };
    expect(checkResponseShape({ id: 1, extra: true, more: 'x' }, schema)).toEqual([]);
  });

  it('checks array element shape and reports the element index', () => {
    const schema = {
      type: 'array',
      items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    };
    const out = checkResponseShape([{ id: 1 }, {}], schema);
    expect(out).toEqual([
      { path: '$[1].id', kind: 'missing-required', expected: 'present', actual: 'absent' },
    ]);
  });

  it('rejects a value outside a declared enum', () => {
    const out = checkResponseShape('c', { type: 'string', enum: ['a', 'b'] });
    expect(out).toEqual([{ path: '$', kind: 'enum', expected: '"a" | "b"', actual: '"c"' }]);
  });

  it('accepts null when the schema is nullable', () => {
    expect(checkResponseShape(null, { type: 'string', nullable: true })).toEqual([]);
    expect(checkResponseShape(null, { type: ['string', 'null'] })).toEqual([]);
  });

  it('rejects null for a non-nullable typed schema', () => {
    const out = checkResponseShape(null, { type: 'string' });
    expect(out).toEqual([{ path: '$', kind: 'type-mismatch', expected: 'string', actual: 'null' }]);
  });

  it('passes a value that matches one anyOf branch and fails when none match', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(checkResponseShape(5, schema)).toEqual([]);
    expect(checkResponseShape('hi', schema)).toEqual([]);
    const out = checkResponseShape(true, schema);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('type-mismatch');
    expect(out[0].path).toBe('$');
  });

  it('distinguishes integer from a non-integer number', () => {
    const out = checkResponseShape(
      { n: 1.5 },
      { type: 'object', properties: { n: { type: 'integer' } } },
    );
    expect(out).toEqual([
      { path: '$.n', kind: 'type-mismatch', expected: 'integer', actual: 'number' },
    ]);
    expect(
      checkResponseShape({ n: 2 }, { type: 'object', properties: { n: { type: 'integer' } } }),
    ).toEqual([]);
  });

  it('recurses into nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        meta: { type: 'object', required: ['total'], properties: { total: { type: 'integer' } } },
      },
    };
    const out = checkResponseShape({ meta: { total: 'x' } }, schema);
    expect(out).toEqual([
      { path: '$.meta.total', kind: 'type-mismatch', expected: 'integer', actual: 'string' },
    ]);
  });
});
