import type { JsonSchema } from '../types/index.js';
import { inferJsonSchema } from './har-schema-inferrer.js';

/**
 * Merge multiple JSON schemas into one that covers all observed fields.
 * Uses a union approach: if a field appears in any sample, it's included
 * (marked optional if not present in all samples).
 */
export function mergeSchemas(schemas: JsonSchema[]): JsonSchema {
  if (schemas.length === 0) return { type: 'object' };
  if (schemas.length === 1) return schemas[0];

  // Only merge object schemas
  if (!schemas.every((s) => s.type === 'object')) return schemas[0];

  const allProperties = new Map<string, JsonSchema[]>();
  const requiredCounts = new Map<string, number>();

  for (const schema of schemas) {
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((schema.required as string[]) ?? []);

    for (const [key, propSchema] of Object.entries(props)) {
      const existing = allProperties.get(key);
      if (existing) existing.push(propSchema);
      else allProperties.set(key, [propSchema]);

      if (required.has(key)) {
        requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const mergedProperties: Record<string, JsonSchema> = {};
  const mergedRequired: string[] = [];

  for (const [key, propSchemas] of allProperties) {
    // Use the most common type
    mergedProperties[key] = propSchemas[0];

    // Only required if present in ALL samples
    if ((requiredCounts.get(key) ?? 0) === schemas.length) {
      mergedRequired.push(key);
    }
  }

  return {
    type: 'object',
    properties: mergedProperties,
    ...(mergedRequired.length > 0 ? { required: mergedRequired } : {}),
  };
}

/**
 * Merge request body schemas from multiple HAR entries in a cluster.
 */
export function mergeRequestBodySchemas(
  bodies: Array<{ text: string; mimeType: string }>,
): JsonSchema | undefined {
  const schemas: JsonSchema[] = [];

  for (const body of bodies) {
    if (!body.text || !body.mimeType.includes('json')) continue;
    try {
      schemas.push(inferJsonSchema(JSON.parse(body.text)));
    } catch {
      continue;
    }
  }

  if (schemas.length === 0) return undefined;
  return mergeSchemas(schemas);
}
