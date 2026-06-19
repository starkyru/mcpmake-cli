import { describe, it, expect } from 'vitest';
import { mergeSchemas, mergeRequestBodySchemas } from '../../src/transformer/schema-merger.js';

describe('schema-merger', () => {
  it('returns single schema unchanged', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    expect(mergeSchemas([schema])).toEqual(schema);
  });

  it('merges properties from multiple schemas', () => {
    const s1 = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const s2 = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name', 'age'],
    };
    const merged = mergeSchemas([s1, s2]);
    expect(Object.keys(merged.properties as object)).toContain('name');
    expect(Object.keys(merged.properties as object)).toContain('age');
  });

  it('marks fields as required only if in all samples', () => {
    const s1 = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const s2 = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
    };
    const merged = mergeSchemas([s1, s2]);
    expect(merged.required).toContain('a');
    expect(merged.required).not.toContain('b'); // only in s2
  });

  it('returns empty object for no schemas', () => {
    expect(mergeSchemas([])).toEqual({ type: 'object' });
  });
});

describe('mergeRequestBodySchemas', () => {
  it('merges JSON bodies', () => {
    const bodies = [
      { text: '{"name":"Alice"}', mimeType: 'application/json' },
      { text: '{"name":"Bob","age":30}', mimeType: 'application/json' },
    ];
    const merged = mergeRequestBodySchemas(bodies);
    expect(merged).toBeDefined();
    expect(Object.keys(merged!.properties as object)).toContain('name');
    expect(Object.keys(merged!.properties as object)).toContain('age');
  });

  it('returns undefined for non-JSON', () => {
    const bodies = [{ text: 'plain text', mimeType: 'text/plain' }];
    expect(mergeRequestBodySchemas(bodies)).toBeUndefined();
  });
});
