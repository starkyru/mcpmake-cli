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
});
