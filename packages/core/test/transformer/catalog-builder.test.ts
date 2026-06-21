import { describe, it, expect } from 'vitest';
import { buildCatalog } from '../../src/transformer/catalog-builder.js';
import type { ToolDefinition } from '../../src/types/index.js';

function makeTool(name: string, method = 'get', bodyInputKey?: string): ToolDefinition {
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
    paramMappings: [
      { inputKey: 'id', wireName: 'id', in: 'path' },
      { inputKey: 'limit', wireName: 'limit', in: 'query' },
    ],
    hasRequestBody: method === 'post',
    requestBodyContentType: 'application/json',
    ...(bodyInputKey !== undefined ? { bodyInputKey } : {}),
    buildHeadersBody: '  return {};',
    operationMeta: '{"method":"get","path":"/test"}',
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
    // pathParams and queryParams are now mapping objects, not plain strings
    expect(catalog[0].pathParams).toEqual([{ inputKey: 'id', wireName: 'id' }]);
    expect(catalog[0].queryParams).toEqual([{ inputKey: 'limit', wireName: 'limit' }]);
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

  it('carries bodyInputKey when tool has a non-default body key', () => {
    // Simulates an operation where a param named "body" already existed, so
    // schema-converter assigned bodyInputKey = "requestBody".
    const tool = makeTool('create_item', 'post', 'requestBody');
    const catalog = buildCatalog([tool]);
    expect(catalog[0].bodyInputKey).toBe('requestBody');
  });

  it('carries bodyInputKey="body" when tool uses the default body key', () => {
    const tool = makeTool('create_default', 'post', 'body');
    const catalog = buildCatalog([tool]);
    expect(catalog[0].bodyInputKey).toBe('body');
  });

  it('omits bodyInputKey for tools without a request body', () => {
    // GET tools have no body; bodyInputKey must not appear in the entry.
    const tool = makeTool('list_items', 'get');
    const catalog = buildCatalog([tool]);
    expect(catalog[0].bodyInputKey).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(catalog[0], 'bodyInputKey')).toBe(false);
  });

  it('omits bodyInputKey when hasRequestBody is true but bodyInputKey is undefined on the tool', () => {
    // Older/partial ToolDefinitions may not set bodyInputKey; catalog must not
    // emit the field (so the template falls back to "body" safely).
    const tool: ToolDefinition = {
      ...makeTool('create_old', 'post'),
      // explicitly leave bodyInputKey absent (spread above sets hasRequestBody=true)
    };
    delete (tool as any).bodyInputKey;
    const catalog = buildCatalog([tool]);
    expect(Object.prototype.hasOwnProperty.call(catalog[0], 'bodyInputKey')).toBe(false);
  });

  // R14-A: parameter name collision — query param `id` exposed under `id_query`
  it('R14-A: stores disambiguated inputKey for colliding path/query params', () => {
    const tool: ToolDefinition = {
      name: 'get_item',
      title: 'Get Item',
      description: 'Get item by id',
      inputSchemaCode: 'z.object({ id: z.string(), id_query: z.string().optional() })',
      operationId: 'getItem',
      method: 'get' as any,
      pathTemplate: '/items/{id}',
      // legacy wire-name arrays (not used for catalog; paramMappings takes precedence)
      pathParams: ['id'],
      queryParams: ['id'],
      headerParams: [],
      // paramMappings carries the disambiguated inputKey for the colliding query param
      paramMappings: [
        { inputKey: 'id', wireName: 'id', in: 'path' },
        { inputKey: 'id_query', wireName: 'id', in: 'query' },
      ],
      hasRequestBody: false,
      requestBodyContentType: 'application/json',
      buildHeadersBody: '  return {};',
      operationMeta: '{"method":"get","path":"/items/{id}"}',
      fileName: 'get-item',
      functionName: 'getItem',
      buildUrlBody: '  return url;',
    };
    const catalog = buildCatalog([tool]);
    const entry = catalog[0];

    // Path param: inputKey and wireName are both 'id' (no collision on path side)
    expect(entry.pathParams).toEqual([{ inputKey: 'id', wireName: 'id' }]);

    // Query param: inputKey is the disambiguated 'id_query'; wireName stays 'id'
    expect(entry.queryParams).toEqual([{ inputKey: 'id_query', wireName: 'id' }]);
  });

  it('R14-A: non-colliding params have identical inputKey and wireName', () => {
    // Common case — no collision, inputKey === wireName on both path and query.
    const catalog = buildCatalog([makeTool('list_things')]);
    const entry = catalog[0];
    expect(entry.pathParams[0].inputKey).toBe(entry.pathParams[0].wireName);
    expect(entry.queryParams[0].inputKey).toBe(entry.queryParams[0].wireName);
  });
});
