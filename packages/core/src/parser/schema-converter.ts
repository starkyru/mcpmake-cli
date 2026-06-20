import { jsonSchemaToZod } from 'json-schema-to-zod';
import type { OperationDescriptor, JsonSchema, ParamMapping } from '../types/index.js';
import { logger } from '../utils/logger.js';

const MAX_SCHEMA_DEPTH = 15;

/**
 * Pre-process a JSON Schema to simplify common patterns before Zod conversion.
 * Handles: single-item allOf (unwrap), nullable types, circular refs, array root wrapping.
 */
function simplifySchema(schema: JsonSchema, depth = 0, seen = new WeakSet<object>()): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;

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
      return simplifySchema({ ...inner, ...rest }, depth + 1, seen);
    }

    // Handle nullable shorthand: { type: "string", nullable: true }
    if (schema.nullable === true && schema.type) {
      const { nullable, ...rest } = schema;
      return { oneOf: [rest as JsonSchema, { type: 'null' }] };
    }

    // Recursively simplify nested schemas
    if (schema.properties && typeof schema.properties === 'object') {
      const simplified: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
        simplified[key] = simplifySchema(value, depth + 1, seen);
      }
      return { ...schema, properties: simplified };
    }

    if (schema.items && typeof schema.items === 'object') {
      return { ...schema, items: simplifySchema(schema.items as JsonSchema, depth + 1, seen) };
    }

    return schema;
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

export function jsonSchemaToZodCode(schema: JsonSchema): string {
  try {
    const simplified = simplifySchema(schema);
    return jsonSchemaToZod(simplified, { module: 'none' });
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
    mappings.push({ inputKey, wireName: param.name, in: param.in });

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

  if (op.requestBody) {
    let bodyName = 'body';
    if (seenKeys.has(bodyName)) {
      bodyName = 'requestBody';
    }
    seenKeys.add(bodyName);

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
  return { code, mappings };
}
