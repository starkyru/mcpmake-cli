import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApiSpec } from '../../src/parser/openapi-loader.js';
import { extractOperations } from '../../src/parser/operation-extractor.js';
import type { OpenAPIV3 } from 'openapi-types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal well-formed OpenAPI 3.0 document used as a base for targeted tests. */
function minimalDoc(overrides: Partial<OpenAPIV3.Document> = {}): OpenAPIV3.Document {
  return {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0.0' },
    paths: {},
    ...overrides,
  };
}

describe('operation-extractor', () => {
  it('extracts all operations from petstore spec', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const result = extractOperations(api as OpenAPIV3.Document);

    expect(result.operations).toHaveLength(4);
    const ids = result.operations.map((op) => op.operationId);
    expect(ids).toContain('listPets');
    expect(ids).toContain('createPet');
    expect(ids).toContain('showPetById');
    expect(ids).toContain('deletePet');
  });

  it('extracts base URL from servers', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const result = extractOperations(api as OpenAPIV3.Document);
    expect(result.baseUrl).toBe('https://petstore.swagger.io/v1');
  });

  it('extracts security schemes', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const result = extractOperations(api as OpenAPIV3.Document);
    expect(Object.keys(result.securitySchemes)).toContain('ApiKeyAuth');
    expect(Object.keys(result.securitySchemes)).toContain('BearerAuth');
  });

  it('extracts path parameters', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const result = extractOperations(api as OpenAPIV3.Document);
    const showPet = result.operations.find((op) => op.operationId === 'showPetById')!;
    expect(showPet.parameters).toHaveLength(1);
    expect(showPet.parameters[0].name).toBe('petId');
    expect(showPet.parameters[0].in).toBe('path');
    expect(showPet.parameters[0].required).toBe(true);
  });

  it('extracts query parameters', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const result = extractOperations(api as OpenAPIV3.Document);
    const listPets = result.operations.find((op) => op.operationId === 'listPets')!;
    expect(listPets.parameters).toHaveLength(1);
    expect(listPets.parameters[0].name).toBe('limit');
    expect(listPets.parameters[0].in).toBe('query');
    expect(listPets.parameters[0].required).toBe(false);
  });

  it('extracts request body', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const result = extractOperations(api as OpenAPIV3.Document);
    const createPet = result.operations.find((op) => op.operationId === 'createPet')!;
    expect(createPet.requestBody).toBeDefined();
    expect(createPet.requestBody!.contentType).toBe('application/json');
    expect(createPet.requestBody!.required).toBe(true);
  });

  it('extracts global security on each operation', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const result = extractOperations(api as OpenAPIV3.Document);
    // petstore has global security: ApiKeyAuth
    for (const op of result.operations) {
      expect(op.security.length).toBeGreaterThan(0);
      expect(op.security[0].schemeName).toBe('ApiKeyAuth');
    }
  });
});

// ---------------------------------------------------------------------------
// R20-A: guards for fields omitted in minimal/LLM-generated specs
// ---------------------------------------------------------------------------

describe('operation-extractor — missing optional spec fields (R20-A)', () => {
  it('does not throw when an operation has no responses; returns empty responses array', () => {
    const doc = minimalDoc({
      paths: {
        '/ping': {
          get: {
            operationId: 'ping',
            // `responses` intentionally absent — valid in a minimal/LLM-generated doc
          } as OpenAPIV3.OperationObject,
        },
      },
    });

    const result = extractOperations(doc);

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].operationId).toBe('ping');
    expect(result.operations[0].responses).toEqual([]);
  });

  it('does not throw when the doc has no `info` field; falls back to sensible defaults', () => {
    // Cast through `unknown` because TypeScript rightly treats `info` as required;
    // real-world LLM-generated or hand-rolled docs may omit it.
    const doc = minimalDoc({ info: undefined as unknown as OpenAPIV3.InfoObject });

    const result = extractOperations(doc);

    expect(result.info.title).toBe('api');
    expect(result.info.version).toBe('0.0.0');
    expect(result.info.description).toBeUndefined();
  });

  it('does not throw when `info` is present but has no title or version', () => {
    const doc = minimalDoc({
      info: {} as OpenAPIV3.InfoObject,
    });

    const result = extractOperations(doc);

    expect(result.info.title).toBe('api');
    expect(result.info.version).toBe('0.0.0');
  });

  it('preserves real title/version when info is fully populated', () => {
    const doc = minimalDoc({
      info: { title: 'My Service', version: '2.1.0', description: 'Does stuff' },
    });

    const result = extractOperations(doc);

    expect(result.info.title).toBe('My Service');
    expect(result.info.version).toBe('2.1.0');
    expect(result.info.description).toBe('Does stuff');
  });

  it('handles a mix: missing responses on one operation, present on another', () => {
    const doc = minimalDoc({
      paths: {
        '/a': {
          get: {
            operationId: 'opA',
            // no responses
          } as OpenAPIV3.OperationObject,
        },
        '/b': {
          get: {
            operationId: 'opB',
            responses: {
              '200': { description: 'ok' },
            },
          },
        },
      },
    });

    const result = extractOperations(doc);

    const opA = result.operations.find((o) => o.operationId === 'opA')!;
    const opB = result.operations.find((o) => o.operationId === 'opB')!;

    expect(opA.responses).toEqual([]);
    expect(opB.responses).toHaveLength(1);
    expect(opB.responses[0].statusCode).toBe('200');
  });
});
