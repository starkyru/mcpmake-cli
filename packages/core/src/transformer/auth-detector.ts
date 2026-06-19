import type { OpenAPIV3 } from 'openapi-types';
import type { AuthScheme, EnvVarDescriptor } from '../types/index.js';

export interface OAuthFlowInfo {
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes: string[];
  flowType: 'authorizationCode' | 'clientCredentials' | 'implicit' | 'password';
}

export interface AuthDetectOptions {
  /**
   * Only emit the named OpenAPI security scheme (the rest are ignored). Maps a
   * Stainless `security_scheme` choice so the generated server uses the same
   * credential the SDK did, even when the spec declares several schemes.
   */
  onlyScheme?: string;
  /**
   * Override the credential env-var name for the single-secret schemes (apiKey /
   * http-bearer). Maps a Stainless `read_env` so the generated server reads e.g.
   * `ACME_API_KEY` instead of mcpmake's default. Ignored for basic/oauth2
   * (multiple secrets — there is no single name to rename).
   */
  envVarName?: string;
}

export function detectAuthSchemes(
  securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>,
  options?: AuthDetectOptions,
): { authSchemes: AuthScheme[]; envVars: EnvVarDescriptor[]; oauthFlows: OAuthFlowInfo[] } {
  const authSchemes: AuthScheme[] = [];
  const envVars: EnvVarDescriptor[] = [];
  const oauthFlows: OAuthFlowInfo[] = [];

  // Honour an explicit scheme choice (Stainless `security_scheme`) when it
  // exists; otherwise emit every detected scheme as before.
  let entries = Object.entries(securitySchemes);
  if (options?.onlyScheme && securitySchemes[options.onlyScheme]) {
    entries = entries.filter(([name]) => name === options.onlyScheme);
  }

  // Renaming the credential env var is only unambiguous for a single emitted,
  // single-secret scheme. Apply it to the chosen scheme, or the sole scheme.
  const renameTarget =
    options?.envVarName !== undefined
      ? (options.onlyScheme ?? (entries.length === 1 ? entries[0][0] : undefined))
      : undefined;

  for (const [name, scheme] of entries) {
    if (scheme.type === 'apiKey') {
      const envVarName = name === renameTarget ? options!.envVarName! : 'API_KEY';
      authSchemes.push({
        type: 'apiKey',
        envVarName,
        headerName: scheme.name,
        in: scheme.in as 'header' | 'query' | 'cookie',
        description: `API key for ${name}`,
      });
      envVars.push({
        name: envVarName,
        description: `API key (sent as ${scheme.in} "${scheme.name}")`,
        required: true,
      });
    } else if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      const envVarName = name === renameTarget ? options!.envVarName! : 'BEARER_TOKEN';
      authSchemes.push({
        type: 'http-bearer',
        envVarName,
        description: `Bearer token for ${name}`,
      });
      envVars.push({
        name: envVarName,
        description: 'Bearer authentication token',
        required: true,
      });
    } else if (scheme.type === 'http' && scheme.scheme === 'basic') {
      authSchemes.push({
        type: 'http-basic',
        envVarName: 'BASIC_USERNAME',
        description: `Basic auth for ${name}`,
      });
      envVars.push(
        { name: 'BASIC_USERNAME', description: 'Basic auth username', required: true },
        { name: 'BASIC_PASSWORD', description: 'Basic auth password', required: true },
      );
    } else if (scheme.type === 'oauth2') {
      authSchemes.push({
        type: 'oauth2',
        envVarName: 'OAUTH2_CLIENT_ID',
        description: `OAuth2 for ${name}`,
      });

      // Extract flow details
      const flows = scheme.flows;
      if (flows?.authorizationCode) {
        const flow = flows.authorizationCode;
        oauthFlows.push({
          authorizationUrl: flow.authorizationUrl,
          tokenUrl: flow.tokenUrl,
          scopes: Object.keys(flow.scopes ?? {}),
          flowType: 'authorizationCode',
        });
      }
      if (flows?.clientCredentials) {
        const flow = flows.clientCredentials;
        oauthFlows.push({
          tokenUrl: flow.tokenUrl,
          scopes: Object.keys(flow.scopes ?? {}),
          flowType: 'clientCredentials',
        });
      }

      // Emit OAuth env vars
      envVars.push(
        { name: 'OAUTH2_CLIENT_ID', description: 'OAuth2 client ID', required: true },
        { name: 'OAUTH2_CLIENT_SECRET', description: 'OAuth2 client secret', required: false },
        {
          name: 'OAUTH2_TOKEN',
          description: 'Pre-obtained OAuth2 token (alternative to client credentials)',
          required: false,
        },
      );

      if (flows?.authorizationCode) {
        envVars.push({
          name: 'OAUTH2_REDIRECT_URI',
          description: 'OAuth2 redirect URI for authorization code flow',
          required: false,
          example: 'http://localhost:3000/callback',
        });
      }
    }
  }

  // Deduplicate env vars by name
  const seen = new Set<string>();
  const uniqueEnvVars = envVars.filter((v) => {
    if (seen.has(v.name)) return false;
    seen.add(v.name);
    return true;
  });

  return { authSchemes, envVars: uniqueEnvVars, oauthFlows };
}
