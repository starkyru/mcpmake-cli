import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadOpenApiSpec,
  convertSwagger2ToOpenApi3,
  type Swagger2Doc,
} from '../../src/parser/openapi-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

// ---------------------------------------------------------------------------
// Helpers for Swagger 2.0 converter tests
// ---------------------------------------------------------------------------

/** Minimal Swagger 2.0 doc skeleton; individual tests fill in what they need. */
function makeDoc(overrides: Partial<Swagger2Doc> = {}): Swagger2Doc {
  return {
    swagger: '2.0',
    info: { title: 'Test', version: '1.0' },
    ...overrides,
  };
}

/** Pull the converted parameters array for the given method on a path. */
function opParams(
  result: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown>[] {
  const paths = result.paths as Record<string, unknown>;
  const pathItem = paths[path] as Record<string, unknown>;
  const operation = pathItem[method] as Record<string, unknown>;
  return (operation.parameters ?? []) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Swagger 2.0 → OpenAPI 3.0 converter: $ref parameter resolution (R12-C)
// ---------------------------------------------------------------------------

describe('convertSwagger2ToOpenApi3 — operation-level $ref parameters', () => {
  it('resolves path and query $refs from the global parameters map', () => {
    const doc = makeDoc({
      parameters: {
        IdParam: { name: 'id', in: 'path', required: true, type: 'string' },
        PageParam: { name: 'page', in: 'query', type: 'integer' },
      },
      paths: {
        '/users/{id}': {
          get: {
            operationId: 'getUser',
            parameters: [{ $ref: '#/parameters/IdParam' }, { $ref: '#/parameters/PageParam' }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const params = opParams(result, '/users/{id}', 'get');

    expect(params).toHaveLength(2);

    const id = params.find((p) => p.name === 'id');
    expect(id).toBeDefined();
    expect(id!.in).toBe('path');
    expect(id!.required).toBe(true);
    expect((id!.schema as Record<string, unknown>).type).toBe('string');

    const page = params.find((p) => p.name === 'page');
    expect(page).toBeDefined();
    expect(page!.in).toBe('query');
    expect((page!.schema as Record<string, unknown>).type).toBe('integer');

    // No junk param with undefined name/in.
    expect(params.some((p) => p.name === undefined || p.in === undefined)).toBe(false);
  });

  it('correctly mixes inline params with $ref params in the same operation', () => {
    const doc = makeDoc({
      parameters: {
        PageParam: { name: 'page', in: 'query', type: 'integer' },
      },
      paths: {
        '/items': {
          get: {
            operationId: 'listItems',
            parameters: [
              { name: 'limit', in: 'query', type: 'integer' },
              { $ref: '#/parameters/PageParam' },
            ],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const params = opParams(result, '/items', 'get');

    expect(params).toHaveLength(2);
    expect(params.map((p) => p.name).sort()).toEqual(['limit', 'page']);
    expect(params.every((p) => p.in === 'query')).toBe(true);
  });
});

describe('convertSwagger2ToOpenApi3 — $ref body parameters', () => {
  it('resolves a $ref body param and emits requestBody', () => {
    const doc = makeDoc({
      consumes: ['application/json'],
      parameters: {
        UserBody: {
          name: 'body',
          in: 'body',
          required: true,
          schema: { $ref: '#/definitions/User' },
        },
      },
      definitions: {
        User: { type: 'object', properties: { name: { type: 'string' } } },
      },
      paths: {
        '/users': {
          post: {
            operationId: 'createUser',
            parameters: [{ $ref: '#/parameters/UserBody' }],
            responses: { 201: { description: 'created' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const paths = result.paths as Record<string, unknown>;
    const post = (paths['/users'] as Record<string, unknown>).post as Record<string, unknown>;

    expect(post.requestBody).toBeDefined();
    const rb = post.requestBody as Record<string, unknown>;
    expect(rb.required).toBe(true);

    const content = rb.content as Record<string, unknown>;
    expect(content['application/json']).toBeDefined();

    // No stray parameters array (body was consumed into requestBody).
    expect(post.parameters).toBeUndefined();
  });
});

describe('convertSwagger2ToOpenApi3 — unresolvable $ref is warned and skipped', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits logger.warn and produces no junk param when the ref target is missing', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const doc = makeDoc({
      // No global parameters — the ref is unresolvable.
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            parameters: [{ $ref: '#/parameters/MissingParam' }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const paths = result.paths as Record<string, unknown>;
    const get = (paths['/things'] as Record<string, unknown>).get as Record<string, unknown>;

    const params = (get.parameters ?? []) as unknown[];
    expect(params).toHaveLength(0);

    const refWarnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('#/parameters/MissingParam'),
    );
    expect(refWarnings.length).toBeGreaterThan(0);
  });

  it('warns and skips $ref forms that are not #/parameters/ (e.g. external refs)', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const doc = makeDoc({
      paths: {
        '/things': {
          get: {
            operationId: 'listThings2',
            parameters: [{ $ref: 'external.yaml#/parameters/SomeParam' }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const paths = result.paths as Record<string, unknown>;
    const get = (paths['/things'] as Record<string, unknown>).get as Record<string, unknown>;

    const params = (get.parameters ?? []) as unknown[];
    expect(params).toHaveLength(0);

    const refWarnings = warnSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === 'string' && args[0].includes('external.yaml#/parameters/SomeParam'),
    );
    expect(refWarnings.length).toBeGreaterThan(0);
  });
});

describe('convertSwagger2ToOpenApi3 — path-level $ref parameters', () => {
  it('resolves $ref entries in the path item parameters array', () => {
    const doc = makeDoc({
      parameters: {
        TenantId: { name: 'tenantId', in: 'path', required: true, type: 'string' },
      },
      paths: {
        '/tenants/{tenantId}/resources': {
          parameters: [{ $ref: '#/parameters/TenantId' }],
          get: {
            operationId: 'listResources',
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const paths = result.paths as Record<string, unknown>;
    const pathItem = paths['/tenants/{tenantId}/resources'] as Record<string, unknown>;

    const pathParams = (pathItem.parameters ?? []) as Record<string, unknown>[];
    expect(pathParams).toHaveLength(1);
    expect(pathParams[0].name).toBe('tenantId');
    expect(pathParams[0].in).toBe('path');
    expect(pathParams[0].required).toBe(true);
  });

  it('skips an unresolvable path-level $ref with a warn and emits no junk param', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const doc = makeDoc({
      paths: {
        '/things/{id}': {
          parameters: [{ $ref: '#/parameters/GhostParam' }],
          get: {
            operationId: 'getThing',
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const paths = result.paths as Record<string, unknown>;
    const pathItem = paths['/things/{id}'] as Record<string, unknown>;

    const pathParams = (pathItem.parameters ?? []) as unknown[];
    expect(pathParams).toHaveLength(0);

    const refWarnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('#/parameters/GhostParam'),
    );
    expect(refWarnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// R13-A: percent-encoded and JSON-Pointer-escaped $ref names (R13-A)
// ---------------------------------------------------------------------------

describe('convertSwagger2ToOpenApi3 — percent-encoded $ref names (R13-A)', () => {
  it('resolves a $ref whose name is percent-encoded (e.g. "My%20Param" → "My Param")', () => {
    const doc = makeDoc({
      parameters: {
        'My Param': { name: 'myParam', in: 'query', type: 'string' },
      },
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            parameters: [{ $ref: '#/parameters/My%20Param' }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const params = opParams(result, '/things', 'get');

    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('myParam');
    expect(params[0].in).toBe('query');
  });

  it('resolves a $ref with a JSON Pointer tilde-escape in the name (e.g. "x~1y" → "x/y")', () => {
    const doc = makeDoc({
      parameters: {
        'x/y': { name: 'slashParam', in: 'query', type: 'integer' },
      },
      paths: {
        '/items': {
          get: {
            operationId: 'listItems',
            parameters: [{ $ref: '#/parameters/x~1y' }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const params = opParams(result, '/items', 'get');

    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('slashParam');
  });

  it('still warns and skips a ref that is genuinely missing after decoding', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const doc = makeDoc({
      paths: {
        '/nowhere': {
          get: {
            operationId: 'nowhere',
            parameters: [{ $ref: '#/parameters/Does%20Not%20Exist' }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const paths = result.paths as Record<string, unknown>;
    const get = (paths['/nowhere'] as Record<string, unknown>).get as Record<string, unknown>;
    expect((get.parameters ?? []) as unknown[]).toHaveLength(0);

    const refWarnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('#/parameters/Does%20Not%20Exist'),
    );
    expect(refWarnings.length).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// A4-M1 — malformed percent-encoding in $ref must warn+skip, not throw
// ---------------------------------------------------------------------------

describe('convertSwagger2ToOpenApi3 — malformed percent-encoding in $ref (A4-M1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when $ref contains a malformed escape (%ZZ); warns and skips', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const doc = makeDoc({
      parameters: {
        GoodParam: { name: 'good', in: 'query', type: 'string' },
      },
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            parameters: [
              // Malformed escape — decodeURIComponent would throw URIError here.
              { $ref: '#/parameters/%ZZ' },
              // Valid ref that must still be resolved despite the bad one above.
              { $ref: '#/parameters/GoodParam' },
            ],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    // Must not throw.
    const result = convertSwagger2ToOpenApi3(doc);

    // The bad ref is silently skipped; the good one resolves normally.
    const params = opParams(result, '/test', 'get');
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('good');

    // A warning mentioning the bad ref must have been emitted.
    const badRefWarnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('#/parameters/%ZZ'),
    );
    expect(badRefWarnings.length).toBeGreaterThan(0);
  });

  it('does not throw when $ref contains a bare % (%); warns and skips', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const doc = makeDoc({
      paths: {
        '/bare': {
          get: {
            operationId: 'barePercent',
            // '%' by itself is a malformed percent sequence.
            parameters: [{ $ref: '#/parameters/%' }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const params = opParams(result, '/bare', 'get');
    expect(params).toHaveLength(0);

    const warnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('#/parameters/%'),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('still resolves a validly percent-encoded ref (%20 in name) after the fix', () => {
    // Regression guard: the try/catch must not swallow legitimate decoding.
    const doc = makeDoc({
      parameters: {
        'My Param': { name: 'myParam', in: 'query', type: 'string' },
      },
      paths: {
        '/encoded': {
          get: {
            operationId: 'encodedRef',
            parameters: [{ $ref: '#/parameters/My%20Param' }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const params = opParams(result, '/encoded', 'get');
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('myParam');
  });
});

describe('convertSwagger2ToOpenApi3 — inline (non-$ref) params are unaffected', () => {
  it('converts inline query and path params correctly', () => {
    const doc = makeDoc({
      paths: {
        '/pets/{id}': {
          get: {
            operationId: 'getPet',
            parameters: [
              { name: 'id', in: 'path', required: true, type: 'string' },
              { name: 'fields', in: 'query', type: 'string', enum: ['name', 'age'] },
            ],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });

    const result = convertSwagger2ToOpenApi3(doc);
    const params = opParams(result, '/pets/{id}', 'get');

    expect(params).toHaveLength(2);
    const id = params.find((p) => p.name === 'id')!;
    expect(id.in).toBe('path');
    expect(id.required).toBe(true);

    const fields = params.find((p) => p.name === 'fields')!;
    expect(fields.in).toBe('query');
    expect((fields.schema as Record<string, unknown>).enum).toEqual(['name', 'age']);
  });
});

// ---------------------------------------------------------------------------
// Original openapi-loader integration tests (unchanged)
// ---------------------------------------------------------------------------

describe('openapi-loader', () => {
  it('loads and dereferences a YAML spec', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    expect(api).toBeDefined();
    expect((api as any).openapi).toBe('3.0.0');
    expect((api as any).info.title).toBe('Swagger Petstore');
  });

  it('resolves $ref pointers', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const getPets = (api as any).paths['/pets'].get;
    const responseSchema = getPets.responses['200'].content['application/json'].schema;
    // After dereference, should be an array, not a $ref
    expect(responseSchema.type).toBe('array');
    expect(responseSchema.items).toHaveProperty('properties');
  });

  it('rejects an invalid spec path', async () => {
    await expect(loadOpenApiSpec('/nonexistent/file.yaml')).rejects.toThrow();
  });

  describe('SSRF guard (L-ssrf-spec)', () => {
    // The guard rejects literal private/reserved IPs in-memory, before any
    // network call, so these need no fetch mocking and make no real requests.
    it('refuses a remote spec URL pointing at the cloud metadata endpoint', async () => {
      await expect(loadOpenApiSpec('http://169.254.169.254/openapi.json')).rejects.toThrow(
        /private\/reserved/i,
      );
    });

    it('refuses a remote spec URL pointing at loopback', async () => {
      await expect(loadOpenApiSpec('http://127.0.0.1/openapi.json')).rejects.toThrow(
        /private\/reserved/i,
      );
    });

    it('refuses a remote spec URL pointing at IPv6 loopback', async () => {
      await expect(loadOpenApiSpec('http://[::1]/openapi.json')).rejects.toThrow(
        /private\/reserved/i,
      );
    });
  });
});
