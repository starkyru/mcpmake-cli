import { jsonSchemaToZod } from 'json-schema-to-zod';
import type {
  OperationDescriptor,
  JsonSchema,
  ParamMapping,
  BodyParamDescriptor,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

const MAX_SCHEMA_DEPTH = 15;

/** True when a schema's type admits `null` (so `default: null` is coherent). */
function schemaAllowsNull(schema: JsonSchema): boolean {
  if (schema.nullable === true || schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = schema[keyword];
    if (
      Array.isArray(branches) &&
      branches.some((b) => b && typeof b === 'object' && (b as JsonSchema).type === 'null')
    ) {
      return true;
    }
  }
  // No type constraint at all (bare {} / description-only) → zod z.any(), null is fine.
  return (
    schema.type === undefined &&
    schema.oneOf === undefined &&
    schema.anyOf === undefined &&
    schema.allOf === undefined &&
    schema.properties === undefined &&
    schema.items === undefined &&
    schema.enum === undefined
  );
}

/** True when `def` matches a single JSON Schema type keyword. */
function valueMatchesType(type: string, def: unknown): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(def);
    case 'object':
      return typeof def === 'object' && def !== null && !Array.isArray(def);
    case 'string':
      return typeof def === 'string';
    case 'number':
    case 'integer':
      return typeof def === 'number';
    case 'boolean':
      return typeof def === 'boolean';
    case 'null':
      return def === null;
    default:
      return true;
  }
}

/**
 * True when a declared `default` is coherent with the schema, i.e. keeping it
 * will produce compiling zod code. Real-world specs carry garbage defaults
 * (openai: `default: []` on a string enum, `default: "eval"` on an array) that
 * json-schema-to-zod emits verbatim as `.default(<garbage>)` — a TS2769 in the
 * generated project. Unjudgeable cases (no `type`, unions) are kept as-is.
 */
function defaultMatchesSchema(schema: JsonSchema, def: unknown): boolean {
  if (def === null) return schemaAllowsNull(schema);
  const type = schema.type;
  if (typeof type === 'string' && !valueMatchesType(type, def)) return false;
  if (Array.isArray(type) && !type.some((t) => valueMatchesType(t as string, def))) return false;
  // Primitive default not in the enum → z.enum([...]).default(<other>) won't compile.
  if (
    Array.isArray(schema.enum) &&
    ['string', 'number', 'boolean'].includes(typeof def) &&
    !schema.enum.includes(def)
  ) {
    return false;
  }
  return true;
}

/**
 * Cap on the TOTAL number of schema nodes expanded per top-level conversion.
 *
 * A dereferenced OpenAPI doc is a DAG: heavily shared components (stripe's
 * `customer`/`charge`/`subscription` web) are expanded once PER USE SITE, so
 * the expanded tree can be exponentially larger than the document even under
 * the depth cap — stripe OOMs an 8 GB heap on a single operation, and
 * kubernetes emits 68 MB of tool sources that tsc cannot check. Past the
 * budget a subtree degrades to a permissive object (`z.record(z.any())`),
 * which keeps the tool callable (arguments still flow through; the upstream
 * API enforces the real contract) and keeps the emitted inputSchema at a size
 * an LLM can actually consume. Traversal order is deterministic, so truncation
 * is stable across runs.
 */
const MAX_SCHEMA_NODES = 800;

interface ExpansionBudget {
  remaining: number;
}

/**
 * Nested (non-root) schema descriptions are capped: kubernetes-style specs
 * attach multi-paragraph docs to every leaf, which dominates the emitted zod
 * code (68 MB of tool sources) without helping a model call the tool. The
 * root description (the tool/body text an LLM actually reads first) is never
 * trimmed. Cut at a sentence boundary when one exists reasonably early.
 */
const MAX_NESTED_DESCRIPTION_LENGTH = 200;

function trimNestedDescription(description: string): string {
  if (description.length <= MAX_NESTED_DESCRIPTION_LENGTH) return description;
  const head = description.slice(0, MAX_NESTED_DESCRIPTION_LENGTH);
  const sentenceEnd = head.indexOf('. ');
  return sentenceEnd > 40 ? head.slice(0, sentenceEnd + 1) : `${head}…`;
}

/**
 * Pre-process a JSON Schema to simplify common patterns before Zod conversion.
 * Handles: single-item allOf (unwrap), nullable types, circular refs, array root
 * wrapping, and bounds total expansion via {@link MAX_SCHEMA_NODES}.
 */
function simplifySchema(
  schema: JsonSchema,
  depth = 0,
  seen = new WeakSet<object>(),
  budget: ExpansionBudget = { remaining: MAX_SCHEMA_NODES },
): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;

  if (budget.remaining-- <= 0) {
    return { type: 'object', description: 'Truncated: schema too large' };
  }

  // Circular reference detection: `seen` is the set of nodes on the current DFS
  // path (ancestors only). A hit here is a true back-edge to an ancestor, i.e. an
  // infinite cycle. A node reused across sibling branches (DAG/diamond) is NOT an
  // ancestor when revisited, so it is fully expanded each time instead of being
  // falsely truncated and silently dropping fields (M2).
  if (seen.has(schema)) {
    return { type: 'object', description: 'Truncated: circular reference' };
  }

  // Depth limit (independent of cycle detection; bounds even acyclic deep nesting).
  if (depth > MAX_SCHEMA_DEPTH) {
    return { type: 'object', description: 'Truncated: max depth exceeded' };
  }

  seen.add(schema);
  try {
    // Unwrap single-item allOf (common in OpenAPI after $ref resolution)
    if (schema.allOf && Array.isArray(schema.allOf) && schema.allOf.length === 1) {
      const inner = schema.allOf[0] as JsonSchema;
      const { allOf, ...rest } = schema;
      return simplifySchema({ ...inner, ...rest }, depth + 1, seen, budget);
    }

    // Drop defaults that contradict the schema's own type (docker-engine:
    // `default: null` on an array; openai: `default: []` on a string enum).
    // json-schema-to-zod emits them verbatim as `.default(<garbage>)`, which
    // does not typecheck (TS2769). Coherent defaults are preserved.
    if (schema.default !== undefined && !defaultMatchesSchema(schema, schema.default)) {
      const { default: _default, ...rest } = schema;
      schema = rest as JsonSchema;
    }

    // Handle nullable shorthand: { type: "string", nullable: true }.
    // A `default` must be hoisted onto the union wrapper: leaving it on the
    // inner branch would emit `.default(null)` on the non-null zod type.
    if (schema.nullable === true && schema.type) {
      const { nullable, default: defaultValue, ...rest } = schema;
      const union: JsonSchema = {
        oneOf: [simplifySchema(rest as JsonSchema, depth + 1, seen, budget), { type: 'null' }],
      };
      if (defaultValue !== undefined) {
        (union as Record<string, unknown>).default = defaultValue;
      }
      return union;
    }

    // Recursively simplify nested schemas. Keywords can coexist on one node
    // (e.g. properties + anyOf), so compose instead of returning at the first
    // match — and recurse into union branches, which real-world specs nest
    // `nullable`/`default: null` inside just as often as under properties.
    let out = schema;
    const mutable = (): Record<string, unknown> => {
      if (out === schema) out = { ...schema };
      return out as Record<string, unknown>;
    };

    if (
      depth > 0 &&
      typeof schema.description === 'string' &&
      schema.description.length > MAX_NESTED_DESCRIPTION_LENGTH
    ) {
      mutable().description = trimNestedDescription(schema.description);
    }

    if (schema.properties && typeof schema.properties === 'object') {
      const simplified: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
        simplified[key] = simplifySchema(value, depth + 1, seen, budget);
      }
      mutable().properties = simplified;
    }

    if (schema.items && typeof schema.items === 'object') {
      mutable().items = simplifySchema(schema.items as JsonSchema, depth + 1, seen, budget);
    }

    for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) {
      const branches = schema[keyword];
      if (Array.isArray(branches)) {
        mutable()[keyword] = branches.map((branch) =>
          simplifySchema(branch as JsonSchema, depth + 1, seen, budget),
        );
      }
    }

    return out;
  } finally {
    // Remove from the DFS path once this subtree is fully processed so sibling
    // branches that share the same node are not mistaken for cycles.
    seen.delete(schema);
  }
}

/**
 * Wrap array root schemas in an object for MCP outputSchema compatibility.
 * MCP outputSchema requires an object root, not a bare array.
 */
export function wrapArrayRoot(schema: JsonSchema): JsonSchema {
  if (schema.type === 'array') {
    return {
      type: 'object',
      properties: { items: schema },
      required: ['items'],
    };
  }
  return schema;
}

/**
 * Byte ceiling for one conversion's emitted zod code. The node budget bounds
 * STRUCTURE but not bytes (long property names/descriptions): stripe's 587
 * tools each emit >100 KB under the node cap alone — 69 MB of sources that
 * OOM tsc. When the emitted code exceeds this, the conversion re-runs with a
 * halved node budget until it fits (deterministic; unaffected schemas never
 * re-run). 16 KB of zod ≈ 12 KB of JSON schema — still generous for a tool.
 */
const MAX_ZOD_CODE_BYTES = 16_000;
const MIN_SCHEMA_NODES = 50;

export function jsonSchemaToZodCode(schema: JsonSchema): string {
  try {
    let budget = MAX_SCHEMA_NODES;
    for (;;) {
      const simplified = simplifySchema(schema, 0, new WeakSet(), { remaining: budget });
      const code = jsonSchemaToZod(simplified, { module: 'none' });
      if (code.length <= MAX_ZOD_CODE_BYTES || budget <= MIN_SCHEMA_NODES) return code;
      budget = Math.floor(budget / 2);
    }
  } catch {
    return 'z.any()';
  }
}

/**
 * Convert a schema to Zod code, wrapping array roots for outputSchema.
 */
export function jsonSchemaToOutputZodCode(schema: JsonSchema): string {
  return jsonSchemaToZodCode(wrapArrayRoot(schema));
}

export interface InputSchemaResult {
  /** Zod object code for the tool's inputSchema. */
  code: string;
  /**
   * Mapping from each emitted MCP input key to the original wire name and
   * location. The handler uses this to build the upstream request, so the
   * original API parameter name is preserved even when the input key differs
   * (D-H1) and header/cookie/query params are no longer silently dropped (D-H2).
   */
  mappings: ParamMapping[];
  /**
   * The input key under which the request body is emitted in the schema, or
   * undefined if there is no request body. Consumers (e.g. tool-builder) must
   * use this value rather than re-deriving it so the two stay in lock-step when
   * both `body` and `requestBody` are already taken by named parameters.
   */
  bodyInputKey: string | undefined;
  /**
   * The body descriptor (inputKey + schema + required + description) for the
   * Python emitter's Pydantic-model generation (A4-H2), or undefined when there
   * is no request body. Carries the body's JSON Schema alongside the same
   * inputKey as {@link bodyInputKey} so the two cannot drift.
   */
  bodyParam: BodyParamDescriptor | undefined;
}

export function buildOperationInputSchema(op: OperationDescriptor): InputSchemaResult {
  const fields: string[] = [];
  const mappings: ParamMapping[] = [];
  // Track the MCP input keys we have already emitted so colliding parameters
  // (e.g. a query and a header both named `token`) get distinct keys.
  const seenKeys = new Set<string>();

  const uniqueKey = (wireName: string, location: string): string => {
    // The wire name is emitted as a JSON.stringify'd object key, so any string
    // is a legal property — we keep the original name as the input key for
    // fidelity and only disambiguate true collisions.
    let key = wireName;
    if (seenKeys.has(key)) {
      key = `${wireName}_${location}`;
      logger.warn(`Parameter name collision: "${wireName}" exposed as "${key}"`);
    }
    let n = 1;
    while (seenKeys.has(key)) {
      key = `${wireName}_${location}_${n++}`;
    }
    seenKeys.add(key);
    return key;
  };

  for (const param of op.parameters) {
    const inputKey = uniqueKey(param.name, param.in);
    // Carry the per-param required/schema/description so the Python emitter can
    // build a precise annotation (A4-H2). The TS emitter ignores the new fields.
    mappings.push({
      inputKey,
      wireName: param.name,
      in: param.in,
      required: param.required,
      schema: param.schema,
      description: param.description,
    });

    const zodType = jsonSchemaToZodCode(param.schema);
    let field = zodType;
    if (!param.required) {
      field = `${field}.optional()`;
    }
    if (param.description) {
      field = `${field}.describe(${JSON.stringify(param.description)})`;
    }
    // The key is JSON.stringify'd so names like `page-size` or `2fa` are legal
    // TS object keys instead of producing invalid source (D-H1).
    fields.push(`  ${JSON.stringify(inputKey)}: ${field}`);
  }

  let bodyInputKey: string | undefined;
  let bodyParam: BodyParamDescriptor | undefined;
  if (op.requestBody) {
    // Choose a body key that does not collide with any parameter key already
    // in seenKeys. Start with `body`, fall back to `requestBody`, then append
    // numeric suffixes (`requestBody_2`, `requestBody_3`, …) until unique —
    // mirroring the convention used by uniqueKey() above for param collisions.
    let bodyName = 'body';
    if (seenKeys.has(bodyName)) {
      bodyName = 'requestBody';
    }
    let n = 2;
    while (seenKeys.has(bodyName)) {
      bodyName = `requestBody_${n++}`;
    }
    seenKeys.add(bodyName);
    bodyInputKey = bodyName;
    // The schema may be absent on hand-built fixtures; default to an empty
    // schema so downstream consumers always receive a real object (A4-H2).
    bodyParam = {
      inputKey: bodyName,
      schema: op.requestBody.schema ?? {},
      required: op.requestBody.required ?? false,
      description: op.requestBody.description,
    };

    const bodyZod = jsonSchemaToZodCode(op.requestBody.schema);
    let field = bodyZod;
    if (!op.requestBody.required) {
      field = `${field}.optional()`;
    }
    if (op.requestBody.description) {
      field = `${field}.describe(${JSON.stringify(op.requestBody.description)})`;
    }
    fields.push(`  ${JSON.stringify(bodyName)}: ${field}`);
  }

  const code = fields.length === 0 ? 'z.object({})' : `z.object({\n${fields.join(',\n')},\n})`;
  return { code, mappings, bodyInputKey, bodyParam };
}
