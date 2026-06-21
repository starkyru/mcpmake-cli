import { describe, it, expect } from 'vitest';
import { buildResources, buildPrompts } from '../../src/transformer/resource-builder.js';
import type { OperationDescriptor } from '../../src/types/index.js';

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'listItems',
    method: 'get',
    path: '/items',
    tags: ['items'],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

describe('resource-builder', () => {
  it('creates static resource for GET list endpoints', () => {
    const resources = buildResources([makeOp()]);
    expect(resources).toHaveLength(1);
    expect(resources[0].isTemplate).toBeUndefined();
    expect(resources[0].uri).toBe('api://list_items');
  });

  it('creates template resource for parameterized GET endpoints', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getItem',
        path: '/items/{itemId}',
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0].isTemplate).toBe(true);
    expect(resources[0].templateParams).toEqual(['itemId']);
    expect(resources[0].uri).toContain('{itemId}');
  });

  it('ignores non-GET operations', () => {
    const resources = buildResources([makeOp({ method: 'post' })]);
    expect(resources).toHaveLength(0);
  });

  it('handles both list and detail endpoints', () => {
    const resources = buildResources([
      makeOp({ operationId: 'listItems', path: '/items' }),
      makeOp({
        operationId: 'getItem',
        path: '/items/{id}',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    expect(resources).toHaveLength(2);
    expect(resources[0].isTemplate).toBeUndefined();
    expect(resources[1].isTemplate).toBe(true);
  });

  // R11-B: two operationIds that collapse to the same toToolName must produce
  // distinct resource names and URIs — no "Resource X is already registered" crash.
  it('R11-B: deduplicates resource names when operationIds collide under toToolName', () => {
    // 'listItems' and 'ListItems' both snake-case to 'list_items'
    const resources = buildResources([
      makeOp({ operationId: 'listItems', path: '/items' }),
      makeOp({ operationId: 'ListItems', path: '/items/all' }),
    ]);
    expect(resources).toHaveLength(2);
    expect(resources[0].name).toBe('list_items');
    expect(resources[0].uri).toBe('api://list_items');
    // Second collision gets the _2 suffix; name and uri must agree.
    expect(resources[1].name).toBe('list_items_2');
    expect(resources[1].uri).toBe('api://list_items_2');
  });

  // R11-B: three-way collision escalates through _2, _3 without reuse.
  it('R11-B: handles three-way name collision with incrementing suffix', () => {
    const resources = buildResources([
      makeOp({ operationId: 'listItems', path: '/items' }),
      makeOp({ operationId: 'ListItems', path: '/items/all' }),
      makeOp({ operationId: 'LIST_ITEMS', path: '/items/search' }),
    ]);
    expect(resources.map((r) => r.name)).toEqual(['list_items', 'list_items_2', 'list_items_3']);
    expect(resources.map((r) => r.uri)).toEqual([
      'api://list_items',
      'api://list_items_2',
      'api://list_items_3',
    ]);
  });

  // variables-based urlBody (R-fix): single path param
  it('emits variables-based substitution for GET /items/{itemId}', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getItem',
        path: '/items/{itemId}',
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    expect(resources).toHaveLength(1);
    const { urlBody } = resources[0];
    // Must reference variables['itemId'], not pathParts positional indexing
    expect(urlBody).toContain("variables['itemId']");
    expect(urlBody).toContain("url.replace('{itemId}'");
    expect(urlBody).not.toContain('pathParts');
    expect(urlBody).not.toContain('pathParts[');
  });

  // variables-based urlBody (R-fix): multiple path params across deep path
  it('emits variables substitution for all params in GET /v1/users/{userId}/posts/{postId}', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getUserPost',
        path: '/v1/users/{userId}/posts/{postId}',
        parameters: [
          { name: 'userId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'postId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    ]);
    expect(resources).toHaveLength(1);
    const { urlBody } = resources[0];
    expect(urlBody).toContain("variables['userId']");
    expect(urlBody).toContain("url.replace('{userId}'");
    expect(urlBody).toContain("variables['postId']");
    expect(urlBody).toContain("url.replace('{postId}'");
    expect(urlBody).not.toContain('pathParts');
  });

  // variables-based urlBody (R-fix): param name containing a non-identifier char (dot).
  // R16-B: uriTemplateVar replaces (not strips) dots: 'user.id' → 'user_id'.
  // The uriTemplate uses {user_id}, SDK extracts variables['user_id'].
  // The replace target must still be the raw wire form: '{user.id}'.
  it('R16-B: maps raw wire name to RFC-6570-safe key for param with dot in name', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getUser',
        path: '/users/{user.id}',
        parameters: [{ name: 'user.id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    expect(resources).toHaveLength(1);
    const { urlBody, uri } = resources[0];
    // replace target is the raw wire name as it appears in op.path
    expect(urlBody).toContain("url.replace('{user.id}'");
    // variable key uses RFC-6570-safe name (dot replaced with underscore → 'user_id')
    expect(urlBody).toContain("variables['user_id']");
    // uriTemplate must use the safe name, not the raw dot form
    expect(uri).toContain('{user_id}');
    expect(uri).not.toContain('{user.id}');
    expect(urlBody).not.toContain('pathParts');
  });

  // R16-B: hyphen in param name is invalid in RFC 6570; must be replaced with '_'.
  it('R16-B: replaces hyphens in path param names with underscores in URI template and variables key', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getUser',
        path: '/users/{user-id}',
        parameters: [{ name: 'user-id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    expect(resources).toHaveLength(1);
    const { urlBody, uri } = resources[0];
    // URI template must use the RFC-6570-safe var name
    expect(uri).toContain('{user_id}');
    expect(uri).not.toContain('{user-id}');
    // variables key matches the safe var name
    expect(urlBody).toContain("variables['user_id']");
    // op.path replace target is still the raw wire token
    expect(urlBody).toContain("url.replace('{user-id}'");
    expect(urlBody).not.toContain('pathParts');
  });

  // R16-B: two params whose uriTemplateVar results collide get distinct deduped names.
  // 'a.b' → 'a_b' and 'a_b' → 'a_b' (collision) → second becomes 'a_b_2'.
  it('R16-B: deduplicates colliding RFC-6570 var names with _2 suffix', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getItem',
        path: '/items/{a.b}/{a_b}',
        parameters: [
          { name: 'a.b', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'a_b', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    ]);
    expect(resources).toHaveLength(1);
    const { urlBody, uri } = resources[0];
    // URI template must have two distinct variable names
    expect(uri).toContain('{a_b}');
    expect(uri).toContain('{a_b_2}');
    // No duplicate curly-brace token: {a_b} should appear once in the template part
    // (the second occurrence is the deduped {a_b_2})
    const varPart = uri.split('api://get_item/')[1];
    expect(varPart).toBe('{a_b}/{a_b_2}');
    // Handler reads each param under its unique key
    expect(urlBody).toContain("variables['a_b']");
    expect(urlBody).toContain("variables['a_b_2']");
    // Raw wire tokens are still used as replace targets
    expect(urlBody).toContain("url.replace('{a.b}'");
    expect(urlBody).toContain("url.replace('{a_b}'");
  });

  // R16-B: common case — alphanumeric param name is unchanged.
  it('R16-B: alphanumeric param name passes through uriTemplateVar unchanged', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getItem',
        path: '/items/{itemId}',
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    expect(resources).toHaveLength(1);
    const { urlBody, uri } = resources[0];
    expect(uri).toContain('{itemId}');
    expect(urlBody).toContain("variables['itemId']");
    expect(urlBody).toContain("url.replace('{itemId}'");
  });
});

describe('buildPrompts', () => {
  function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
    return {
      operationId: 'listItems',
      method: 'get',
      path: '/items',
      tags: ['items'],
      parameters: [],
      responses: [],
      security: [],
      deprecated: false,
      ...overrides,
    };
  }

  // R11-C: two tags that map to the same toToolName must produce distinct
  // _workflow prompt names — no "Prompt X is already registered" crash.
  it('R11-C: deduplicates prompt names when tags collide under toToolName', () => {
    const ops = [
      makeOp({ operationId: 'listOrders', tags: ['Orders'] }),
      makeOp({ operationId: 'getOrder', tags: ['orders'] }),
    ];
    const prompts = buildPrompts(ops);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].name).toBe('orders_workflow');
    expect(prompts[1].name).toBe('orders_workflow_2');
  });

  // R11-C: three-way tag collision.
  it('R11-C: handles three-way tag collision with incrementing suffix', () => {
    const ops = [
      makeOp({ operationId: 'op1', tags: ['Orders'] }),
      makeOp({ operationId: 'op2', tags: ['orders'] }),
      makeOp({ operationId: 'op3', tags: ['ORDERS'] }),
    ];
    const prompts = buildPrompts(ops);
    expect(prompts.map((p) => p.name)).toEqual([
      'orders_workflow',
      'orders_workflow_2',
      'orders_workflow_3',
    ]);
  });

  // R11-A: an op with an unsupported request-body content type is skipped by
  // buildAllTools, so it must not appear in the workflow prompt's tool list.
  it('R11-A: excludes ops with unsupported request-body content type from tool list', () => {
    const ops = [
      makeOp({
        operationId: 'createItemJson',
        method: 'post',
        tags: ['items'],
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: { type: 'object' },
        },
      }),
      makeOp({
        operationId: 'uploadItemXml',
        method: 'post',
        tags: ['items'],
        requestBody: { required: true, contentType: 'application/xml', schema: { type: 'object' } },
      }),
      makeOp({
        operationId: 'submitForm',
        method: 'post',
        tags: ['items'],
        requestBody: {
          required: true,
          contentType: 'application/x-www-form-urlencoded',
          schema: { type: 'object' },
        },
      }),
    ];
    const prompts = buildPrompts(ops);
    expect(prompts).toHaveLength(1);
    // JSON and form-encoded ops must appear; XML op must be absent.
    expect(prompts[0].template).toContain('create_item_json');
    expect(prompts[0].template).toContain('submit_form');
    expect(prompts[0].template).not.toContain('upload_item_xml');
  });

  // R11-A: op with no request body is always included.
  it('R11-A: includes ops with no request body regardless', () => {
    const ops = [
      makeOp({ operationId: 'listItems', tags: ['items'] }),
      makeOp({
        operationId: 'patchItem',
        method: 'patch',
        tags: ['items'],
        // no requestBody field at all
      }),
    ];
    const prompts = buildPrompts(ops);
    expect(prompts[0].template).toContain('list_items');
    expect(prompts[0].template).toContain('patch_item');
  });

  // R11-A: +json media types (e.g. application/vnd.api+json) are supported.
  it('R11-A: includes ops with +json content types', () => {
    const ops = [
      makeOp({
        operationId: 'createItem',
        method: 'post',
        tags: ['items'],
        requestBody: {
          required: true,
          contentType: 'application/vnd.api+json',
          schema: { type: 'object' },
        },
      }),
    ];
    const prompts = buildPrompts(ops);
    expect(prompts[0].template).toContain('create_item');
  });
});
