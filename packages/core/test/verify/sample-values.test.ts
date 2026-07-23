import { describe, it, expect } from 'vitest';
import { deriveParamSample } from '../../src/verify/sample-values.js';

describe('deriveParamSample', () => {
  it('prefers an explicit example', () => {
    expect(deriveParamSample({ type: 'string', example: 'abc', default: 'zzz' })).toBe('abc');
  });

  it('falls back to default, then const, then first enum entry', () => {
    expect(deriveParamSample({ type: 'string', default: 'dv' })).toBe('dv');
    expect(deriveParamSample({ type: 'string', const: 'cv' })).toBe('cv');
    expect(deriveParamSample({ type: 'string', enum: ['first', 'second'] })).toBe('first');
  });

  it('unwraps an OpenAPI 3.0 examples object (`.value`)', () => {
    expect(deriveParamSample({ examples: { sample: { value: 'wrapped' } } })).toBe('wrapped');
  });

  it('reads the first entry of an OpenAPI 3.1 examples array', () => {
    expect(deriveParamSample({ examples: ['arr-first', 'arr-second'] })).toBe('arr-first');
  });

  it('accepts number and boolean samples', () => {
    expect(deriveParamSample({ type: 'integer', example: 42 })).toBe(42);
    expect(deriveParamSample({ type: 'boolean', example: true })).toBe(true);
  });

  it('returns undefined for an unconstrained schema (never fabricates a value)', () => {
    expect(deriveParamSample({ type: 'string' })).toBeUndefined();
    expect(deriveParamSample({ type: 'integer' })).toBeUndefined();
    expect(deriveParamSample(undefined)).toBeUndefined();
    expect(deriveParamSample({})).toBeUndefined();
  });

  it('ignores non-scalar examples (objects/arrays cannot go in a URL)', () => {
    expect(deriveParamSample({ example: { nested: true } })).toBeUndefined();
    expect(deriveParamSample({ example: [1, 2, 3] })).toBeUndefined();
    expect(deriveParamSample({ example: Number.NaN })).toBeUndefined();
  });
});
