import type { JsonSchema } from '../types/index.js';

/** A scalar value safe to place into a URL path segment or query string. */
export type ScalarSample = string | number | boolean;

function isScalar(v: unknown): v is ScalarSample {
  return (
    typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean'
  );
}

/**
 * Derive a URL-usable sample value for a parameter's JSON Schema using ONLY
 * explicit, spec-provided values — `example`, `examples`, `default`, `const`, or
 * the first `enum` entry. It never fabricates or guesses a value: an unconstrained
 * `{ type: 'string' }` returns undefined so the caller *skips* the operation
 * rather than send an argument the API never sanctioned. Non-scalar candidates
 * (objects/arrays) are ignored — they cannot go in a path/query anyway.
 */
export function deriveParamSample(schema: JsonSchema | undefined): ScalarSample | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as Record<string, unknown>;

  const candidates: unknown[] = [];
  if ('example' in s) candidates.push(s.example);
  // OpenAPI 3.1 `examples` — array; OpenAPI 3.0 media `examples` — object map.
  if (Array.isArray(s.examples) && s.examples.length > 0) candidates.push(s.examples[0]);
  else if (s.examples && typeof s.examples === 'object') {
    const first = Object.values(s.examples as Record<string, unknown>)[0];
    // 3.0 example objects wrap the value under `.value`.
    if (first && typeof first === 'object' && 'value' in (first as object)) {
      candidates.push((first as { value: unknown }).value);
    } else {
      candidates.push(first);
    }
  }
  if ('default' in s) candidates.push(s.default);
  if (s.const !== undefined) candidates.push(s.const);
  if (Array.isArray(s.enum) && s.enum.length > 0) candidates.push(s.enum[0]);

  for (const c of candidates) {
    if (isScalar(c)) return c;
  }
  return undefined;
}
