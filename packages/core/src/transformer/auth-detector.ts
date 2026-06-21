import type { OpenAPIV3 } from 'openapi-types';
import type { AuthScheme, EnvVarDescriptor } from '../types/index.js';
import { sanitizeHeaderName, sanitizeEnvVarName } from '../utils/sanitize.js';

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
      const envVarName = sanitizeEnvVarName(
        name === renameTarget ? options!.envVarName! : 'API_KEY',
      );
      authSchemes.push({
        type: 'apiKey',
        envVarName,
        // scheme.name (the header/query/cookie key) is untrusted spec input and
        // is emitted into a string literal in the auth/config templates.
        headerName: sanitizeHeaderName(scheme.name),
        in: scheme.in as 'header' | 'query' | 'cookie',
        description: `API key for ${name}`,
        schemeName: name,
      });
      envVars.push({
        name: envVarName,
        description: `API key (sent as ${scheme.in} "${sanitizeHeaderName(scheme.name)}")`,
        required: true,
      });
    } else if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      const envVarName = sanitizeEnvVarName(
        name === renameTarget ? options!.envVarName! : 'BEARER_TOKEN',
      );
      authSchemes.push({
        type: 'http-bearer',
        envVarName,
        description: `Bearer token for ${name}`,
        schemeName: name,
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
        schemeName: name,
      });
      envVars.push(
        { name: 'BASIC_USERNAME', description: 'Basic auth username', required: true },
        { name: 'BASIC_PASSWORD', description: 'Basic auth password', required: true },
      );
    } else if (scheme.type === 'oauth2') {
      // Union of scopes declared across all of this scheme's flows. Baked into
      // the generated config as the default scope set (L-scopes) so spec scopes
      // are no longer silently dropped; runtime `OAUTH2_SCOPES` still overrides.
      const flows = scheme.flows;
      const scopes = [
        ...new Set([
          ...Object.keys(flows?.authorizationCode?.scopes ?? {}),
          ...Object.keys(flows?.clientCredentials?.scopes ?? {}),
          ...Object.keys(flows?.password?.scopes ?? {}),
          ...Object.keys(flows?.implicit?.scopes ?? {}),
        ]),
      ];
      authSchemes.push({
        type: 'oauth2',
        envVarName: 'OAUTH2_CLIENT_ID',
        description: `OAuth2 for ${name}`,
        schemeName: name,
        scopes,
      });

      // Extract flow details
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

  // Mark only the FIRST scheme of each type as the one that emits the shared
  // interface fields in the config templates. Subsequent same-type schemes
  // still contribute their per-scheme runtime assignments (legal TS duplicate
  // object-literal keys — last-wins) but omit the interface property
  // declarations that would produce TS2300 "Duplicate identifier".
  //
  // apiKey: also deduplicated per-location for the `apiKeyQueryName` field.
  // bearer/basic/oauth2: annotated with emitBearer/emitBasic/emitOAuth2 so the
  // node + worker templates suppress the duplicate interface fields (and, for
  // oauth2, the duplicate `resolveOAuthScopes` function declaration → TS2393).
  let firstApiKeySeen = false;
  let firstQueryApiKeySeen = false;
  let firstBearerSeen = false;
  let firstBasicSeen = false;
  let firstOAuth2Seen = false;
  const annotatedSchemes = authSchemes.map((s) => {
    if (s.type === 'apiKey') {
      const emitApiKeyValue = !firstApiKeySeen;
      firstApiKeySeen = true;
      const emitApiKeyQueryName = s.in === 'query' ? !firstQueryApiKeySeen : undefined;
      if (s.in === 'query') firstQueryApiKeySeen = true;
      // The extra annotation properties are not part of the AuthScheme type but
      // ARE present at runtime for Handlebars template consumption. The cast is
      // safe: the receiver (template engine) reads JS objects, not TS types.
      return {
        ...s,
        emitApiKeyValue,
        ...(emitApiKeyQueryName !== undefined && { emitApiKeyQueryName }),
      } as AuthScheme;
    }
    if (s.type === 'http-bearer') {
      const emitBearer = !firstBearerSeen;
      firstBearerSeen = true;
      return { ...s, emitBearer } as AuthScheme;
    }
    if (s.type === 'http-basic') {
      const emitBasic = !firstBasicSeen;
      firstBasicSeen = true;
      return { ...s, emitBasic } as AuthScheme;
    }
    if (s.type === 'oauth2') {
      const emitOAuth2 = !firstOAuth2Seen;
      firstOAuth2Seen = true;
      return { ...s, emitOAuth2 } as AuthScheme;
    }
    return s;
  });

  return { authSchemes: annotatedSchemes, envVars: uniqueEnvVars, oauthFlows };
}
