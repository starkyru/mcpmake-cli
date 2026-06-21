import type { ToolDefinition } from '../types/index.js';

/**
 * Maps the MCP input key (what the agent supplies) to the wire parameter name
 * (what the upstream API expects). Stored on each CatalogEntry path/query param
 * so execute_tool reads `args[inputKey]` but sends under `wireName` (R14-A).
 */
export interface CatalogParamMapping {
  /** The key the agent supplies in the tool input. */
  inputKey: string;
  /** The original API parameter name sent upstream. */
  wireName: string;
}

export interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  method: string;
  path: string;
  inputSchema: Record<string, unknown>;
  /** Path parameters, each carrying both the MCP inputKey and the upstream wireName. */
  pathParams: CatalogParamMapping[];
  /** Query parameters, each carrying both the MCP inputKey and the upstream wireName. */
  queryParams: CatalogParamMapping[];
  hasRequestBody: boolean;
  requestBodyContentType: string;
  /** The MCP input key under which the request body is passed (e.g. `body`,
   *  `requestBody`, `requestBody_2`). Only set when `hasRequestBody` is true. */
  bodyInputKey?: string;
}

/**
 * Build a tool catalog JSON from tool definitions.
 * Used by dynamic discovery mode to avoid registering all tools upfront.
 */
export function buildCatalog(tools: ToolDefinition[]): CatalogEntry[] {
  return tools.map((tool) => {
    // Derive path/query param mappings from paramMappings (which carries the
    // correct inputKey↔wireName pairing after collision disambiguation). Fall
    // back to the legacy string arrays for tools built without paramMappings so
    // that older caller code is not broken (the common case has inputKey===wireName).
    const pathParams: CatalogParamMapping[] = tool.paramMappings
      ? tool.paramMappings
          .filter((m) => m.in === 'path')
          .map((m) => ({ inputKey: m.inputKey, wireName: m.wireName }))
      : tool.pathParams.map((name) => ({ inputKey: name, wireName: name }));

    const queryParams: CatalogParamMapping[] = tool.paramMappings
      ? tool.paramMappings
          .filter((m) => m.in === 'query')
          .map((m) => ({ inputKey: m.inputKey, wireName: m.wireName }))
      : tool.queryParams.map((name) => ({ inputKey: name, wireName: name }));

    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      method: tool.method,
      path: tool.pathTemplate,
      inputSchema: parseInputSchema(tool.inputSchemaCode),
      pathParams,
      queryParams,
      hasRequestBody: tool.hasRequestBody,
      requestBodyContentType: tool.requestBodyContentType,
      ...(tool.hasRequestBody && tool.bodyInputKey !== undefined
        ? { bodyInputKey: tool.bodyInputKey }
        : {}),
    };
  });
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
