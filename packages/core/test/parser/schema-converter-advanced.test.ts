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
    // json-schema-to-zod emits a discriminated-union superRefine that echoes the
    // two branch constructors. Both branches must survive, and the union wrapper
    // (superRefine) must be present so neither branch is silently collapsed.
    expect(code).toContain('z.string()');
    expect(code).toContain('z.number()');
    expect(code).toContain('superRefine');
  });

  it('converts nullable shorthand into a string-or-null union', () => {
    const code = jsonSchemaToZodCode({
      type: 'string',
      nullable: true,
    } as any);
    // simplifySchema rewrites { type:'string', nullable:true } into
    // { oneOf: [{type:'string'}, {type:'null'}] }, which the library emits as a
    // union (superRefine) over z.string() and z.null(). If the nullable branch
    // (schema-converter.ts lines 38-41) regressed, the library would instead
    // emit the plain `z.string().nullable()` — containing neither z.null() nor
    // superRefine — so these assertions fail on that regression.
    expect(code).toContain('z.string()');
    expect(code).toContain('z.null()');
    expect(code).toContain('superRefine');
    expect(code).not.toContain('z.string().nullable()');
  });

  it('emits the z.any() literal for an empty schema', () => {
    const code = jsonSchemaToZodCode({});
    // An empty schema has no constraints; the only correct Zod equivalent is the
    // exact literal `z.any()`. Asserting the precise string (not merely that a
    // string was returned) catches any change away from this behavior.
    expect(code).toBe('z.any()');
  });

  it('unwraps a nested single-item allOf inside properties to a usable enum', () => {
    const code = jsonSchemaToZodCode({
      type: 'object',
      properties: {
        status: {
          allOf: [{ type: 'string', enum: ['active', 'inactive'] }],
        },
      },
    });
    // The nested single-item allOf must resolve to the enum it wraps, not be
    // dropped/degraded to z.any(). Assert the enum constructor with its exact
    // members and that it lives under the `status` property as an optional field.
    expect(code).toContain('z.object');
    expect(code).toContain('"status"');
    expect(code).toContain('z.enum(["active","inactive"])');
    expect(code).toContain('.optional()');
    expect(code).not.toContain('z.any()');
  });
});
