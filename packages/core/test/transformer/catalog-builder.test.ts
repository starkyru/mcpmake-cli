import { describe, it, expect } from 'vitest';
import { buildCatalog } from '../../src/transformer/catalog-builder.js';
import { buildToolDefinition } from '../../src/transformer/tool-builder.js';
import type { OperationDescriptor, ToolDefinition } from '../../src/types/index.js';

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

// ---------------------------------------------------------------------------
// R5-E: the dynamic execute_tool catalog must carry each operation's
// per-operation outbound-auth requirement so it can scope auth exactly like the
// static per-tool handlers (otherwise execute_tool over-applies every scheme).
//
// These build tools through the REAL transformer (buildToolDefinition, which
// runs deriveAuthRequirement on an OperationDescriptor's `security` /
// `securityOptional`) and then through the REAL buildCatalog — no logic is
// reimplemented in the test. Expected values are hand-written from the OpenAPI
// security semantics.
// ---------------------------------------------------------------------------
function makeOp(overrides: Partial<OperationDescriptor>): OperationDescriptor {
  return {
    operationId: 'op',
    method: 'get',
    path: '/things',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

describe('catalog-builder R5-E: authRequirement', () => {
  it('carries { mode: "schemes", schemeNames } for a scheme-scoped operation', () => {
    // security with a named scheme → executeRequest applies ONLY that scheme.
    const tool = buildToolDefinition(
      makeOp({
        operationId: 'getScoped',
        security: [{ schemeName: 'apiKeyAuth', scopes: [] }],
      }),
    );
    const [entry] = buildCatalog([tool]);
    expect(entry.authRequirement).toEqual({ mode: 'schemes', schemeNames: ['apiKeyAuth'] });
  });

  it('collapses multiple security alternatives into the union of scheme names', () => {
    const tool = buildToolDefinition(
      makeOp({
        operationId: 'getMulti',
        security: [
          { schemeName: 'apiKeyAuth', scopes: [] },
          { schemeName: 'bearerAuth', scopes: [] },
        ],
      }),
    );
    const [entry] = buildCatalog([tool]);
    expect(entry.authRequirement).toEqual({
      mode: 'schemes',
      schemeNames: ['apiKeyAuth', 'bearerAuth'],
    });
  });

  it('carries { mode: "public" } for an operation that declares security: []', () => {
    // securityOptional === true mirrors an explicit empty `security: []`, which
    // means PUBLIC: executeRequest must apply NO auth.
    const tool = buildToolDefinition(
      makeOp({ operationId: 'getPublic', security: [], securityOptional: true }),
    );
    const [entry] = buildCatalog([tool]);
    expect(entry.authRequirement).toEqual({ mode: 'public' });
  });

  it('omits authRequirement entirely for an operation with no declared security', () => {
    // Nothing declared → undefined → field absent so the runtime falls back to
    // applying every configured scheme (legacy global behavior). The key must
    // NOT be present at all (not merely set to undefined).
    const tool = buildToolDefinition(makeOp({ operationId: 'getUndeclared', security: [] }));
    expect(tool.authRequirement).toBeUndefined();
    const [entry] = buildCatalog([tool]);
    expect(entry.authRequirement).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, 'authRequirement')).toBe(false);
  });

  it('serializes authRequirement into the JSON that tool-catalog.json carries', () => {
    // tool-catalog.json is JSON.stringify(buildCatalog(...)). Round-trip the
    // scoped + public + undeclared trio through JSON to prove the field survives
    // (and the undeclared one stays absent) exactly as the runtime will read it.
    const tools = [
      buildToolDefinition(
        makeOp({ operationId: 'a', security: [{ schemeName: 's1', scopes: [] }] }),
      ),
      buildToolDefinition(makeOp({ operationId: 'b', security: [], securityOptional: true })),
      buildToolDefinition(makeOp({ operationId: 'c', security: [] })),
    ];
    const roundTripped = JSON.parse(JSON.stringify(buildCatalog(tools)));
    expect(roundTripped[0].authRequirement).toEqual({ mode: 'schemes', schemeNames: ['s1'] });
    expect(roundTripped[1].authRequirement).toEqual({ mode: 'public' });
    expect(Object.prototype.hasOwnProperty.call(roundTripped[2], 'authRequirement')).toBe(false);
  });
});
