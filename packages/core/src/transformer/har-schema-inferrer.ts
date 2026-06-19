import type { JsonSchema } from '../types/index.js';
import { isDangerousKey } from '../utils/sanitize.js';

const MAX_INFERENCE_DEPTH = 20;

/**
 * Infer a JSON Schema from a sample JSON value.
 * Handles objects, arrays, and primitives.
 */
export function inferJsonSchema(value: unknown, depth = 0): JsonSchema {
  if (depth > MAX_INFERENCE_DEPTH) {
    return { type: 'object' };
  }

  if (value === null || value === undefined) {
    return { type: 'string' };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: 'array', items: {} };
    }
    return { type: 'array', items: inferJsonSchema(value[0], depth + 1) };
  }

  if (typeof value === 'object') {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isDangerousKey(key)) continue;
      properties[key] = inferJsonSchema(val, depth + 1);
      if (val !== null && val !== undefined) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }

  return { type: 'string' };
}

/**
 * Try to parse a response body as JSON and infer its schema.
 * Returns undefined if not JSON or parsing fails.
 */
export function inferResponseSchema(
  body: string | undefined,
  mimeType: string,
): JsonSchema | undefined {
  if (!body || !mimeType.includes('json')) return undefined;

  try {
    const parsed = JSON.parse(body);
    return inferJsonSchema(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Try to parse a request body and infer its schema.
 */
export function inferRequestBodySchema(
  text: string | undefined,
  mimeType: string,
): JsonSchema | undefined {
  if (!text) return undefined;

  if (mimeType.includes('json')) {
    try {
      return inferJsonSchema(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  if (mimeType.includes('x-www-form-urlencoded')) {
    const params = new URLSearchParams(text);
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of params) {
      properties[key] = { type: 'string' };
      required.push(key);
      // Try to detect numbers/booleans
      if (/^\d+$/.test(value)) properties[key] = { type: 'integer' };
      else if (value === 'true' || value === 'false') properties[key] = { type: 'boolean' };
    }
    return { type: 'object', properties, required };
  }

  return undefined;
}
