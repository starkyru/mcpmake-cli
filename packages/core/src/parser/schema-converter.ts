import { jsonSchemaToZod } from 'json-schema-to-zod';
import type { OperationDescriptor, JsonSchema } from '../types/index.js';
import { sanitizeIdentifier } from '../utils/sanitize.js';
import { logger } from '../utils/logger.js';

const MAX_SCHEMA_DEPTH = 15;

/**
 * Pre-process a JSON Schema to simplify common patterns before Zod conversion.
 * Handles: single-item allOf (unwrap), nullable types, circular refs, array root wrapping.
 */
function simplifySchema(schema: JsonSchema, depth = 0, seen = new WeakSet<object>()): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;

  // Circular reference detection
  if (seen.has(schema)) {
    return { type: 'object', description: 'Truncated: circular reference' };
  }
  seen.add(schema);

  // Depth limit
  if (depth > MAX_SCHEMA_DEPTH) {
    return { type: 'object', description: 'Truncated: max depth exceeded' };
  }

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

export function buildOperationInputSchema(op: OperationDescriptor): string {
  const fields: string[] = [];
  const seenNames = new Set<string>();

  for (const param of op.parameters) {
    if (param.in === 'header') continue;
    let safeName = sanitizeIdentifier(param.name);

    // Parameter collision resolution
    if (seenNames.has(safeName)) {
      safeName = `${safeName}_${param.in}`;
      logger.warn(`Parameter name collision: "${param.name}" renamed to "${safeName}"`);
    }
    seenNames.add(safeName);

    const zodType = jsonSchemaToZodCode(param.schema);
    let field = zodType;
    if (!param.required) {
      field = `${field}.optional()`;
    }
    if (param.description) {
      field = `${field}.describe(${JSON.stringify(param.description)})`;
    }
    fields.push(`  ${safeName}: ${field}`);
  }

  if (op.requestBody) {
    let bodyName = 'body';
    if (seenNames.has(bodyName)) {
      bodyName = 'requestBody';
    }
    seenNames.add(bodyName);

    const bodyZod = jsonSchemaToZodCode(op.requestBody.schema);
    let field = bodyZod;
    if (!op.requestBody.required) {
      field = `${field}.optional()`;
    }
    if (op.requestBody.description) {
      field = `${field}.describe(${JSON.stringify(op.requestBody.description)})`;
    }
    fields.push(`  ${bodyName}: ${field}`);
  }

  if (fields.length === 0) {
    return 'z.object({})';
  }

  return `z.object({\n${fields.join(',\n')},\n})`;
}
