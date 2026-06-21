import { describe, it, expect } from 'vitest';
import { detectAuthSchemes } from '../../src/transformer/auth-detector.js';
import type { OpenAPIV3 } from 'openapi-types';

describe('auth-detector', () => {
  it('detects apiKey in header', () => {
    const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    };
    const { authSchemes, envVars } = detectAuthSchemes(schemes);
    expect(authSchemes).toHaveLength(1);
    expect(authSchemes[0].type).toBe('apiKey');
    expect(authSchemes[0].headerName).toBe('X-API-Key');
    expect(envVars.find((v) => v.name === 'API_KEY')).toBeDefined();
  });

  it('detects bearer auth', () => {
    const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      BearerAuth: { type: 'http', scheme: 'bearer' },
    };
    const { authSchemes, envVars } = detectAuthSchemes(schemes);
    expect(authSchemes).toHaveLength(1);
    expect(authSchemes[0].type).toBe('http-bearer');
    expect(envVars.find((v) => v.name === 'BEARER_TOKEN')).toBeDefined();
  });

  it('detects basic auth', () => {
    const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      BasicAuth: { type: 'http', scheme: 'basic' },
    };
    const { authSchemes, envVars } = detectAuthSchemes(schemes);
    expect(authSchemes).toHaveLength(1);
    expect(authSchemes[0].type).toBe('http-basic');
    expect(envVars.find((v) => v.name === 'BASIC_USERNAME')).toBeDefined();
    expect(envVars.find((v) => v.name === 'BASIC_PASSWORD')).toBeDefined();
  });

  it('detects oauth2', () => {
    const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      OAuth2: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/auth',
            tokenUrl: 'https://example.com/token',
            scopes: { read: 'Read access' },
          },
        },
      },
    };
    const { authSchemes, envVars } = detectAuthSchemes(schemes);
    expect(authSchemes).toHaveLength(1);
    expect(authSchemes[0].type).toBe('oauth2');
    expect(envVars.find((v) => v.name === 'OAUTH2_TOKEN')).toBeDefined();
  });

  it('deduplicates env vars', () => {
    const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      Bearer1: { type: 'http', scheme: 'bearer' },
      Bearer2: { type: 'http', scheme: 'bearer' },
    };
    const { envVars } = detectAuthSchemes(schemes);
    const bearerVars = envVars.filter((v) => v.name === 'BEARER_TOKEN');
    expect(bearerVars).toHaveLength(1);
  });

  it('handles empty schemes', () => {
    const { authSchemes, envVars } = detectAuthSchemes({});
    expect(authSchemes).toHaveLength(0);
    expect(envVars).toHaveLength(0);
  });

  it('extracts oauth2 flow details', () => {
    const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      OAuth2: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://auth.example.com/token',
            scopes: { read: 'Read access', write: 'Write access' },
          },
        },
      },
    };
    const { authSchemes, envVars, oauthFlows } = detectAuthSchemes(schemes);
    expect(authSchemes[0].type).toBe('oauth2');
    expect(envVars.find((v) => v.name === 'OAUTH2_CLIENT_ID')).toBeDefined();
    expect(envVars.find((v) => v.name === 'OAUTH2_CLIENT_SECRET')).toBeDefined();
    expect(envVars.find((v) => v.name === 'OAUTH2_REDIRECT_URI')).toBeDefined();
    expect(oauthFlows).toHaveLength(1);
    expect(oauthFlows[0].flowType).toBe('authorizationCode');
    expect(oauthFlows[0].scopes).toContain('read');
  });

  it('bakes the union of flow scopes onto the oauth2 scheme (L-scopes)', () => {
    const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      OAuth2: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://auth.example.com/token',
            scopes: { read: 'Read', write: 'Write' },
          },
          clientCredentials: {
            tokenUrl: 'https://auth.example.com/token',
            scopes: { write: 'Write', admin: 'Admin' },
          },
        },
      },
    };
    const { authSchemes } = detectAuthSchemes(schemes);
    expect(authSchemes[0].type).toBe('oauth2');
    // Deduplicated union across flows — spec scopes are no longer dropped.
    expect(authSchemes[0].scopes).toEqual(['read', 'write', 'admin']);
  });

  it('emits an empty scope set when the spec declares none', () => {
    const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      OAuth2: {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: 'https://x/token', scopes: {} } },
      },
    };
    const { authSchemes } = detectAuthSchemes(schemes);
    expect(authSchemes[0].scopes).toEqual([]);
  });

  it('detects client credentials flow', () => {
    const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      OAuth2: {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://auth.example.com/token',
            scopes: {},
          },
        },
      },
    };
    const { oauthFlows } = detectAuthSchemes(schemes);
    expect(oauthFlows).toHaveLength(1);
    expect(oauthFlows[0].flowType).toBe('clientCredentials');
  });

  describe('R23-C — dual apiKey scheme dedup', () => {
    it('marks only the first apiKey scheme with emitApiKeyValue:true', () => {
      const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
        HeaderKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
      };
      const { authSchemes } = detectAuthSchemes(schemes);
      expect(authSchemes).toHaveLength(2);
      // Cast to access the runtime-injected template property.
      const [first, second] = authSchemes as Array<Record<string, unknown>>;
      expect(first['emitApiKeyValue']).toBe(true);
      expect(second['emitApiKeyValue']).toBe(false);
    });

    it('both apiKey schemes retain their per-location metadata', () => {
      const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
        HeaderKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
      };
      const { authSchemes } = detectAuthSchemes(schemes);
      const header = authSchemes.find((s) => s.in === 'header');
      const query = authSchemes.find((s) => s.in === 'query');
      expect(header?.headerName).toBe('X-API-Key');
      expect(query?.headerName).toBe('api_key');
    });

    it('emitApiKeyValue:true on sole apiKey scheme (regression guard)', () => {
      const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      };
      const { authSchemes } = detectAuthSchemes(schemes);
      expect(authSchemes).toHaveLength(1);
      const [sole] = authSchemes as Array<Record<string, unknown>>;
      expect(sole['emitApiKeyValue']).toBe(true);
    });

    it('deduplicates env vars for two apiKey schemes sharing the same name', () => {
      const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
        HeaderKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
      };
      const { envVars } = detectAuthSchemes(schemes);
      const apiKeyVars = envVars.filter((v) => v.name === 'API_KEY');
      // Both schemes resolve to API_KEY — dedup must keep exactly one.
      expect(apiKeyVars).toHaveLength(1);
    });
  });
});
