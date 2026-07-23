import type { JsonSchema } from '../types/index.js';

/**
 * A single structural divergence between a live API response and its declared
 * OpenAPI response schema. Coarser than full JSON-Schema validation on purpose:
 * live-drift detection cares about *shape* (a field vanished, a type changed, an
 * enum value the spec forbids), not about every keyword. Extra properties the
 * response adds are NOT reported — real APIs add fields without breaking clients.
 */
export interface ShapeDivergence {
  /** JSON-path-ish location, e.g. `$.data[0].id`. */
  path: string;
  kind: 'missing-required' | 'type-mismatch' | 'enum' | 'const' | 'not-json';
  /** What the schema declared. */
  expected: string;
  /** What the response actually contained. */
  actual: string;
}

const MAX_DEPTH = 12;
const MAX_DIVERGENCES = 50;
const MAX_ARRAY_ELEMENTS = 20;

/**
 * Structurally check a decoded JSON response value against an OpenAPI response
 * schema. Returns every divergence found (capped), empty when the response
 * matches. Never throws on malformed schemas — an unrecognized schema simply
 * yields no divergences (we cannot assert what we cannot read).
 */
export function checkResponseShape(value: unknown, schema: JsonSchema): ShapeDivergence[] {
  const out: ShapeDivergence[] = [];
  walk(value, schema, '$', 0, out);
  return out;
}

function add(
  out: ShapeDivergence[],
  path: string,
  kind: ShapeDivergence['kind'],
  expected: string,
  actual: string,
): void {
  if (out.length < MAX_DIVERGENCES) out.push({ path, kind, expected, actual });
}

function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function typeList(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string');
  return [];
}

/** Does `value` satisfy at least one of the declared JSON-Schema `types`? */
function matchesAnyType(value: unknown, types: string[]): boolean {
  return types.some((t) => {
    switch (t) {
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'string':
        return typeof value === 'string';
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return jsType(value) === 'object';
      case 'array':
        return Array.isArray(value);
      case 'null':
        return value === null;
      default:
        return false;
    }
  });
}

function walk(
  value: unknown,
  schema: JsonSchema | undefined,
  path: string,
  depth: number,
  out: ShapeDivergence[],
): void {
  if (depth > MAX_DEPTH || out.length >= MAX_DIVERGENCES) return;
  if (!schema || typeof schema !== 'object') return;
  const s = schema as Record<string, unknown>;

  // Combinators. anyOf/oneOf: the value must satisfy at least one branch with
  // zero divergences (we do not enforce oneOf's exactly-one — a live drift check
  // should not fail a response that matches two permissive branches).
  const alts = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined) as
    | JsonSchema[]
    | undefined;
  if (alts && alts.length > 0) {
    for (const branch of alts) {
      const branchOut: ShapeDivergence[] = [];
      walk(value, branch, path, depth + 1, branchOut);
      if (branchOut.length === 0) return; // matched a branch
    }
    add(out, path, 'type-mismatch', describeSchema(s), jsType(value));
    return;
  }
  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf as JsonSchema[]) walk(value, branch, path, depth + 1, out);
    // allOf may combine with own type/properties; fall through to check those too.
  }

  const nullable = s.nullable === true || typeList(s.type).includes('null');
  if (value === null) {
    if (nullable) return;
    if (s.type === undefined && s.enum === undefined && s.const === undefined) return;
    add(out, path, 'type-mismatch', typeList(s.type).join('|') || 'non-null', 'null');
    return;
  }

  if (s.const !== undefined) {
    if (!deepEqual(value, s.const)) {
      add(out, path, 'const', JSON.stringify(s.const), JSON.stringify(value));
    }
    return;
  }

  if (Array.isArray(s.enum)) {
    if (!s.enum.some((e) => deepEqual(e, value))) {
      add(
        out,
        path,
        'enum',
        s.enum.map((e) => JSON.stringify(e)).join(' | '),
        JSON.stringify(value),
      );
    }
    return;
  }

  const types = typeList(s.type);
  if (types.length === 0) {
    // No declared type: infer intent from structural keywords.
    if (s.properties !== undefined || s.required !== undefined)
      checkObject(value, s, path, depth, out);
    else if (s.items !== undefined) checkArray(value, s, path, depth, out);
    return;
  }

  if (!matchesAnyType(value, types)) {
    add(out, path, 'type-mismatch', types.join(' | '), jsType(value));
    return;
  }

  if (jsType(value) === 'object' && types.includes('object'))
    checkObject(value, s, path, depth, out);
  else if (Array.isArray(value) && types.includes('array')) checkArray(value, s, path, depth, out);
}

function checkObject(
  value: unknown,
  s: Record<string, unknown>,
  path: string,
  depth: number,
  out: ShapeDivergence[],
): void {
  if (jsType(value) !== 'object') return;
  const obj = value as Record<string, unknown>;
  const required = Array.isArray(s.required) ? (s.required as unknown[]) : [];
  for (const key of required) {
    if (typeof key === 'string' && !(key in obj)) {
      add(out, `${path}.${key}`, 'missing-required', 'present', 'absent');
    }
  }
  const properties = (s.properties ?? {}) as Record<string, JsonSchema>;
  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in obj) walk(obj[key], propSchema, `${path}.${key}`, depth + 1, out);
  }
}

function checkArray(
  value: unknown,
  s: Record<string, unknown>,
  path: string,
  depth: number,
  out: ShapeDivergence[],
): void {
  if (!Array.isArray(value)) return;
  const items = s.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) return;
  const limit = Math.min(value.length, MAX_ARRAY_ELEMENTS);
  for (let i = 0; i < limit; i++) {
    walk(value[i], items as JsonSchema, `${path}[${i}]`, depth + 1, out);
  }
}

function describeSchema(s: Record<string, unknown>): string {
  const types = typeList(s.type);
  if (types.length > 0) return types.join(' | ');
  if (Array.isArray(s.anyOf)) return 'anyOf';
  if (Array.isArray(s.oneOf)) return 'oneOf';
  return 'matching schema';
}
