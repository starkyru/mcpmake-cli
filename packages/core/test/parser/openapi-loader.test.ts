import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApiSpec } from '../../src/parser/openapi-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

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
