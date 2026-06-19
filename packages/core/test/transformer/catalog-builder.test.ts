import { describe, it, expect } from 'vitest';
import { buildCatalog } from '../../src/transformer/catalog-builder.js';
import type { ToolDefinition } from '../../src/types/index.js';

function makeTool(name: string, method = 'get'): ToolDefinition {
  return {
    name,
    title: name,
    description: `Test tool ${name}`,
    inputSchemaCode: 'z.object({ id: z.string() })',
    operationId: name,
    method: method as any,
    pathTemplate: `/test/${name}`,
    pathParams: ['id'],
    queryParams: ['limit'],
    headerParams: [],
    hasRequestBody: method === 'post',
    requestBodyContentType: 'application/json',
    fileName: name,
    functionName: name,
    buildUrlBody: '  return url;',
  };
}

describe('catalog-builder', () => {
  it('builds catalog from tool definitions', () => {
    const tools = [makeTool('list_users'), makeTool('create_user', 'post')];
    const catalog = buildCatalog(tools);

    expect(catalog).toHaveLength(2);
    expect(catalog[0].name).toBe('list_users');
    expect(catalog[0].method).toBe('get');
    expect(catalog[0].pathParams).toEqual(['id']);
    expect(catalog[0].queryParams).toEqual(['limit']);
    expect(catalog[1].hasRequestBody).toBe(true);
  });

  it('parses input schema fields', () => {
    const catalog = buildCatalog([makeTool('test')]);
    expect(catalog[0].inputSchema).toBeDefined();
    expect((catalog[0].inputSchema as any).type).toBe('object');
  });

  it('handles empty tool list', () => {
    expect(buildCatalog([])).toEqual([]);
  });
});
