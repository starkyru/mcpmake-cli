import type { ToolDefinition } from '../types/index.js';

export interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  method: string;
  path: string;
  inputSchema: Record<string, unknown>;
  pathParams: string[];
  queryParams: string[];
  hasRequestBody: boolean;
  requestBodyContentType: string;
}

/**
 * Build a tool catalog JSON from tool definitions.
 * Used by dynamic discovery mode to avoid registering all tools upfront.
 */
export function buildCatalog(tools: ToolDefinition[]): CatalogEntry[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    method: tool.method,
    path: tool.pathTemplate,
    inputSchema: parseInputSchema(tool.inputSchemaCode),
    pathParams: tool.pathParams,
    queryParams: tool.queryParams,
    hasRequestBody: tool.hasRequestBody,
    requestBodyContentType: tool.requestBodyContentType,
  }));
}

/**
 * Parse the Zod code string into a JSON Schema-like object for the catalog.
 * This is a best-effort conversion for display purposes.
 */
function parseInputSchema(zodCode: string): Record<string, unknown> {
  // Extract field names and types from the Zod code
  const fields: Record<string, string> = {};
  const fieldPattern = /(\w+):\s*z\.(\w+)/g;
  let match;

  while ((match = fieldPattern.exec(zodCode)) !== null) {
    fields[match[1]] = match[2];
  }

  if (Object.keys(fields).length === 0) {
    return { type: 'object', properties: {} };
  }

  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(fields)) {
    properties[name] = { type: mapZodType(type) };
  }

  return { type: 'object', properties };
}

function mapZodType(zodType: string): string {
  switch (zodType) {
    case 'string':
      return 'string';
    case 'number':
    case 'int':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}
