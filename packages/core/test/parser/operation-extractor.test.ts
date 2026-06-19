import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApiSpec } from '../../src/parser/openapi-loader.js';
import { extractOperations } from '../../src/parser/operation-extractor.js';
import type { OpenAPIV3 } from 'openapi-types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

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
