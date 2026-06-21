import type { Entry } from 'har-format';
import type {
  OperationDescriptor,
  HttpMethod,
  ParameterDescriptor,
  RequestBodyDescriptor,
  SecurityRequirement,
  JsonSchema,
} from '../types/index.js';
import type { EntryCluster } from './har-clusterer.js';
import { mergeRequestBodySchemas } from './schema-merger.js';
import type { NormalizedEntry } from '../parser/har-normalizer.js';
import { inferRequestBodySchema } from './har-schema-inferrer.js';

const AUTH_HEADER_PATTERNS: Array<{ pattern: RegExp; schemeName: string }> = [
  { pattern: /^Bearer\s+/i, schemeName: 'bearer' },
  { pattern: /^Basic\s+/i, schemeName: 'basic' },
  { pattern: /^Token\s+/i, schemeName: 'token' },
];

const CUSTOM_AUTH_HEADERS = [
  'x-api-key',
  'api-key',
  'authorization-token',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-session-token',
];

const SESSION_COOKIE_PATTERNS = [
  /^sess/i,
  /^sid$/i,
  /^session/i,
  /^token/i,
  /^auth/i,
  /^jwt/i,
  /^connect\.sid$/i,
];

// Auth-ish query-string keys whose values are secrets (apiKey-in-query).
// Matched case-insensitively against the raw query-param name.
const QUERY_AUTH_KEYS = new Set([
  'api_key',
  'apikey',
  'access_token',
  'token',
  'auth',
  'key',
  'sig',
  'signature',
  'password',
  'secret',
]);

export interface HarConversionResult {
  operations: OperationDescriptor[];
  baseUrl: string;
  detectedAuth: DetectedAuth[];
}

export interface DetectedAuth {
  type: 'bearer' | 'basic' | 'apiKey';
  headerName: string;
  in?: 'header' | 'query' | 'cookie';
  exampleValue?: string;
}

export function clustersToOperations(clusters: EntryCluster[]): HarConversionResult {
  const operations: OperationDescriptor[] = [];
  const allAuth = new Map<string, DetectedAuth>();
  let baseUrl = '';

  for (const cluster of clusters) {
    if (!baseUrl) baseUrl = cluster.baseUrl;

    const canonical = pickCanonicalEntry(cluster.entries);
    const entry = canonical.entry;

    const auth = detectAuth(entry);
    for (const a of auth) {
      allAuth.set(a.headerName.toLowerCase(), a);
    }

    const operationId = generateOperationId(cluster.method, cluster.normalizedPath);

    const parameters: ParameterDescriptor[] = [];

    // Path params from normalization
    for (const pp of canonical.pathParams) {
      const schemaType = pp.inferredType === 'integer' ? 'integer' : 'string';
      const schema: JsonSchema =
        pp.inferredType === 'uuid' ? { type: 'string', format: 'uuid' } : { type: schemaType };
      parameters.push({
        name: pp.name,
        in: 'path',
        required: true,
        description: pp.name,
        schema,
      });
    }

    // Query params merged across all entries in cluster. Auth-bearing query
    // keys are excluded here — they are surfaced as auth schemes, not operation
    // parameters — so their secret values are never retained or emitted.
    const queryTypes = new Map<string, string>();
    for (const ne of cluster.entries) {
      for (const qp of ne.queryParams) {
        if (isQueryAuthKey(qp.name)) continue;
        if (!queryTypes.has(qp.name)) {
          queryTypes.set(qp.name, qp.inferredType);
        }
      }
    }
    for (const [name, type] of queryTypes) {
      parameters.push({
        name,
        in: 'query',
        required: false,
        schema: { type },
      });
    }

    // Request body — merge schemas across all entries in the cluster
    let requestBody: RequestBodyDescriptor | undefined;
    const bodyEntries = cluster.entries
      .map((ne) => ne.entry.request.postData)
      .filter((pd): pd is NonNullable<typeof pd> => !!pd?.text)
      .map((pd) => ({ text: pd.text!, mimeType: pd.mimeType }));

    if (bodyEntries.length > 0) {
      const mergedSchema = mergeRequestBodySchemas(bodyEntries);
      if (mergedSchema) {
        // mergeRequestBodySchemas only processes JSON bodies (mimeType includes
        // "json"), so the merged schema is always JSON-derived. Pick the content
        // type from the first JSON body so the label matches the schema — using
        // bodyEntries[0].mimeType would mislabel the schema as form-encoded if
        // a non-JSON body happens to appear first in the cluster (R10-B).
        const jsonEntry = bodyEntries.find((b) => b.mimeType.includes('json'));
        const contentType = (jsonEntry ?? bodyEntries[0]).mimeType.split(';')[0].trim();
        requestBody = {
          required: true,
          contentType,
          schema: mergedSchema,
        };
      }
    }

    // Security
    const security: SecurityRequirement[] = auth.map((a) => ({
      schemeName: a.type,
      scopes: [],
    }));

    operations.push({
      operationId,
      method: cluster.method as HttpMethod,
      path: cluster.normalizedPath,
      summary: `${cluster.method.toUpperCase()} ${cluster.normalizedPath}`,
      tags: [extractTag(cluster.normalizedPath)],
      parameters,
      requestBody,
      responses: [],
      security,
      deprecated: false,
    });
  }

  return {
    operations,
    baseUrl,
    detectedAuth: [...allAuth.values()],
  };
}

function pickCanonicalEntry(entries: NormalizedEntry[]): NormalizedEntry {
  // Prefer entries with 2xx responses
  const successful = entries.filter(
    (e) => e.entry.response.status >= 200 && e.entry.response.status < 300,
  );
  return successful[0] ?? entries[0];
}

function detectAuth(entry: Entry): DetectedAuth[] {
  const result: DetectedAuth[] = [];

  for (const header of entry.request.headers ?? []) {
    const name = header.name.toLowerCase();

    if (name === 'authorization') {
      for (const { pattern, schemeName } of AUTH_HEADER_PATTERNS) {
        if (pattern.test(header.value)) {
          result.push({
            type: schemeName as DetectedAuth['type'],
            headerName: 'Authorization',
            exampleValue: '[REDACTED]',
          });
          break;
        }
      }
    }

    if (CUSTOM_AUTH_HEADERS.includes(name)) {
      result.push({
        type: 'apiKey',
        headerName: header.name,
        exampleValue: '[REDACTED]',
      });
    }

    // Detect cookie-based session auth
    if (name === 'cookie') {
      const cookies = header.value.split(';').map((c) => c.trim().split('=')[0]);
      for (const cookieName of cookies) {
        if (SESSION_COOKIE_PATTERNS.some((p) => p.test(cookieName))) {
          result.push({
            type: 'apiKey',
            headerName: 'Cookie',
            in: 'cookie',
            exampleValue: '[REDACTED]',
          });
          break;
        }
      }
    }
  }

  // Detect auth tokens passed in the query string. The literal value is never
  // copied into the result — only the (de-duplicated) param name is reported.
  const seenQueryAuth = new Set<string>();
  for (const qs of entry.request.queryString ?? []) {
    if (isQueryAuthKey(qs.name) && !seenQueryAuth.has(qs.name.toLowerCase())) {
      seenQueryAuth.add(qs.name.toLowerCase());
      result.push({
        type: 'apiKey',
        headerName: qs.name,
        in: 'query',
        exampleValue: '[REDACTED]',
      });
    }
  }

  return result;
}

function isQueryAuthKey(name: string): boolean {
  return QUERY_AUTH_KEYS.has(name.toLowerCase());
}

function generateOperationId(method: string, path: string): string {
  const segments = path
    .replace(/\{[^}]+\}/g, '')
    .split('/')
    .filter(Boolean);

  const resource = segments[segments.length - 1] ?? 'resource';

  switch (method.toLowerCase()) {
    case 'get':
      return path.includes('{') ? `get_${singularize(resource)}` : `list_${resource}`;
    case 'post':
      return `create_${singularize(resource)}`;
    case 'put':
    case 'patch':
      return `update_${singularize(resource)}`;
    case 'delete':
      return `delete_${singularize(resource)}`;
    default:
      return `${method.toLowerCase()}_${resource}`;
  }
}

function extractTag(path: string): string {
  const segments = path.split('/').filter((s) => s && !s.startsWith('{'));
  // Skip api/v1/v2 prefixes
  const meaningful = segments.filter((s) => !/^(api|v\d+)$/i.test(s));
  return meaningful[0] ?? 'default';
}

function singularize(word: string): string {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes'))
    return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}
