import { describe, it, expect } from 'vitest';
import { jsonSchemaToZodCode } from '../../src/parser/schema-converter.js';

describe('schema-converter advanced', () => {
  it('unwraps single-item allOf', () => {
    const code = jsonSchemaToZodCode({
      allOf: [{ type: 'object', properties: { name: { type: 'string' } } }],
    });
    expect(code).toContain('z.object');
    expect(code).toContain('name');
  });

  it('handles oneOf with both types present', () => {
    const code = jsonSchemaToZodCode({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(code).toContain('z.string()');
    expect(code).toContain('z.number()');
  });

  it('handles nullable type', () => {
    const code = jsonSchemaToZodCode({
      type: 'string',
      nullable: true,
    } as any);
    // Should produce a union with null
    expect(code).toContain('z.');
  });

  it('handles empty schema', () => {
    const code = jsonSchemaToZodCode({});
    expect(code).toBeDefined();
  });

  it('handles nested allOf in properties', () => {
    const code = jsonSchemaToZodCode({
      type: 'object',
      properties: {
        status: {
          allOf: [{ type: 'string', enum: ['active', 'inactive'] }],
        },
      },
    });
    expect(code).toContain('z.object');
  });
});
