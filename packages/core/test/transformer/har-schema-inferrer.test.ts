import { describe, it, expect } from 'vitest';
import {
  inferJsonSchema,
  inferRequestBodySchema,
} from '../../src/transformer/har-schema-inferrer.js';

describe('har-schema-inferrer', () => {
  describe('inferJsonSchema', () => {
    it('infers string', () => {
      expect(inferJsonSchema('hello')).toEqual({ type: 'string' });
    });

    it('infers integer', () => {
      expect(inferJsonSchema(42)).toEqual({ type: 'integer' });
    });

    it('infers number', () => {
      expect(inferJsonSchema(3.14)).toEqual({ type: 'number' });
    });

    it('infers boolean', () => {
      expect(inferJsonSchema(true)).toEqual({ type: 'boolean' });
    });

    it('infers object', () => {
      const schema = inferJsonSchema({ name: 'Alice', age: 30 });
      expect(schema.type).toBe('object');
      expect((schema.properties as any).name).toEqual({ type: 'string' });
      expect((schema.properties as any).age).toEqual({ type: 'integer' });
      expect(schema.required).toContain('name');
      expect(schema.required).toContain('age');
    });

    it('infers array', () => {
      const schema = inferJsonSchema([1, 2, 3]);
      expect(schema.type).toBe('array');
      expect((schema.items as any).type).toBe('integer');
    });

    it('infers empty array', () => {
      const schema = inferJsonSchema([]);
      expect(schema.type).toBe('array');
    });

    it('handles null', () => {
      const schema = inferJsonSchema(null);
      expect(schema.type).toBe('string');
    });
  });

  describe('inferRequestBodySchema', () => {
    it('infers from JSON body', () => {
      const schema = inferRequestBodySchema(
        '{"name": "Alice", "email": "alice@test.com"}',
        'application/json',
      );
      expect(schema).toBeDefined();
      expect(schema!.type).toBe('object');
      expect((schema!.properties as any).name).toEqual({ type: 'string' });
    });

    it('infers from form-urlencoded', () => {
      const schema = inferRequestBodySchema(
        'name=Alice&age=30',
        'application/x-www-form-urlencoded',
      );
      expect(schema).toBeDefined();
      expect(schema!.type).toBe('object');
      expect((schema!.properties as any).age).toEqual({ type: 'integer' });
    });

    it('returns undefined for non-JSON', () => {
      const schema = inferRequestBodySchema('plain text', 'text/plain');
      expect(schema).toBeUndefined();
    });

    it('returns undefined for empty body', () => {
      const schema = inferRequestBodySchema(undefined, 'application/json');
      expect(schema).toBeUndefined();
    });
  });
});
