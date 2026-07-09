import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI } from 'openapi-types';
import { logger } from '../utils/logger.js';
import { assertPublicUrl } from '../utils/ssrf-guard.js';

export interface LoadResult {
  api: OpenAPI.Document;
  specPath: string;
}

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/**
 * Parser options that route every remote `$ref` fetch through the SSRF guard.
 *
 * The custom `read` runs before any download, so each remote ref URL is rejected
 * if it resolves to a private/reserved host. Redirects are not followed
 * (`redirect: 'error'`): a 3xx to an unvetted host (e.g. the metadata endpoint)
 * surfaces as an error instead of an unguarded fetch.
 */
const guardedHttpResolver = {
  order: 200,
  canRead(file: { url: string }): boolean {
    return /^https?:\/\//i.test(file.url);
  },
  async read(file: { url: string }): Promise<Buffer> {
    await assertPublicUrl(file.url);
    const res = await fetch(file.url, { redirect: 'error' });
    if (!res.ok) {
      throw new Error(`Error downloading ${file.url}: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  },
};

const guardedParserOptions: SwaggerParser.Options = {
  resolve: { http: guardedHttpResolver },
};

/**
 * Detects if a parsed document is Swagger 2.0 and converts it to OpenAPI 3.0.
 */
function isSwagger2(doc: Record<string, unknown>): boolean {
  return typeof doc.swagger === 'string' && doc.swagger.startsWith('2.');
}

/** @internal Exported for unit tests only. */
export interface Swagger2Doc {
  swagger: string;
  info: Record<string, unknown>;
  host?: string;
  basePath?: string;
  schemes?: string[];
  consumes?: string[];
  produces?: string[];
  paths?: Record<string, Record<string, unknown>>;
  definitions?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  securityDefinitions?: Record<string, unknown>;
  security?: unknown[];
  tags?: unknown[];
  externalDocs?: unknown;
}

/**
 * Resolves a Swagger 2.0 parameter `$ref` of the form `#/parameters/<NAME>`
 * against the spec-level global parameters map.  Returns the resolved parameter
 * object, or `null` if the entry is not a `$ref` (caller should treat it as
 * already-inline) or if the reference cannot be resolved (warn + skip).
 *
 * Only `#/parameters/...` refs are handled here.  Schema refs
 * (`#/definitions/...`) remain the responsibility of `convertSchemaRef`.
 */
function resolveParamRef(
  param: Record<string, unknown>,
  globalParameters: Record<string, unknown>,
): Record<string, unknown> | null {
  const ref = param.$ref;
  if (typeof ref !== 'string') {
    // Not a $ref – caller should use the param as-is.
    return null;
  }

  const prefix = '#/parameters/';
  if (!ref.startsWith(prefix)) {
    // A $ref to something other than a top-level parameter (e.g. a path-level
    // parameter defined elsewhere).  We can't resolve it here; skip with a warn.
    logger.warn(`Swagger 2.0 converter: unsupported $ref in parameters array: "${ref}" — skipping`);
    return null;
  }

  // JSON Pointer (RFC 6901) requires ~1→/ and ~0→~ un-escaping AFTER percent-decoding.
  // decodeURIComponent throws URIError on malformed escapes (e.g. "%ZZ"); treat
  // those the same as an unresolvable ref: warn and skip.
  let name: string;
  try {
    name = decodeURIComponent(ref.slice(prefix.length)).replace(/~1/g, '/').replace(/~0/g, '~');
  } catch {
    logger.warn(`Swagger 2.0 converter: malformed percent-encoding in $ref "${ref}" — skipping`);
    return null;
  }
  const resolved = globalParameters[name] as Record<string, unknown> | undefined;
  if (!resolved) {
    logger.warn(
      `Swagger 2.0 converter: parameter $ref "${ref}" not found in global parameters — skipping`,
    );
    return null;
  }

  return resolved;
}

/** @internal Exported for unit tests only. */
export function convertSwagger2ToOpenApi3(doc: Swagger2Doc): Record<string, unknown> {
  logger.warn('Converting Swagger 2.0 to OpenAPI 3.0');

  const scheme = doc.schemes?.[0] ?? 'https';
  const host = doc.host ?? 'localhost';
  const basePath = doc.basePath ?? '/';
  const serverUrl = `${scheme}://${host}${basePath === '/' ? '' : basePath}`;

  const globalConsumes = doc.consumes ?? ['application/json'];
  const globalProduces = doc.produces ?? ['application/json'];

  // Capture the raw global parameters map so that $ref resolution inside
  // operations and path items can inline them before classification.
  const globalParameters: Record<string, unknown> = doc.parameters ?? {};

  const components: Record<string, unknown> = {};

  // Map definitions -> components.schemas. Definitions reference EACH OTHER
  // with `#/definitions/...` $refs, so the whole map must go through the same
  // deep $ref rewrite as operation schemas — copying it verbatim leaves
  // dangling pointers that make dereference fail on any real-world 2.0 spec.
  if (doc.definitions) {
    components.schemas = convertSchemaRef(doc.definitions);
  }

  // Map parameters -> components.parameters
  if (doc.parameters) {
    components.parameters = convertParameterDefinitions(doc.parameters);
  }

  // Map securityDefinitions -> components.securitySchemes
  if (doc.securityDefinitions) {
    components.securitySchemes = convertSecurityDefinitions(doc.securityDefinitions);
  }

  // Convert paths
  const convertedPaths: Record<string, unknown> = {};
  if (doc.paths) {
    for (const [path, pathItem] of Object.entries(doc.paths)) {
      convertedPaths[path] = convertPathItem(
        pathItem as Record<string, unknown>,
        globalConsumes,
        globalProduces,
        globalParameters,
      );
    }
  }

  const result: Record<string, unknown> = {
    openapi: '3.0.0',
    info: doc.info,
    servers: [{ url: serverUrl }],
    paths: convertedPaths,
  };

  if (Object.keys(components).length > 0) {
    result.components = components;
  }
  if (doc.security) {
    result.security = doc.security;
  }
  if (doc.tags) {
    result.tags = doc.tags;
  }
  if (doc.externalDocs) {
    result.externalDocs = doc.externalDocs;
  }

  return result;
}

function convertPathItem(
  pathItem: Record<string, unknown>,
  globalConsumes: string[],
  globalProduces: string[],
  globalParameters: Record<string, unknown>,
): Record<string, unknown> {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const result: Record<string, unknown> = {};

  // Preserve path-level parameters, resolving any $ref entries first.
  if (pathItem.parameters) {
    const rawPathParams = pathItem.parameters as Record<string, unknown>[];
    const resolvedPathParams = rawPathParams.reduce<Record<string, unknown>[]>((acc, p) => {
      const resolved = resolveParamRef(p, globalParameters);
      if (resolved !== null) {
        // Was a $ref — use the resolved object.
        acc.push(resolved);
      } else if (p.$ref === undefined) {
        // Ordinary inline param.
        acc.push(p);
      }
      // If p.$ref is set but resolveParamRef returned null, it already warned; skip.
      return acc;
    }, []);
    if (resolvedPathParams.length > 0) {
      result.parameters = convertParameters(resolvedPathParams);
    }
  }

  for (const method of methods) {
    const operation = pathItem[method] as Record<string, unknown> | undefined;
    if (!operation) continue;
    result[method] = convertOperation(operation, globalConsumes, globalProduces, globalParameters);
  }

  return result;
}

function convertOperation(
  operation: Record<string, unknown>,
  globalConsumes: string[],
  globalProduces: string[],
  globalParameters: Record<string, unknown>,
): Record<string, unknown> {
  const consumes = (operation.consumes as string[]) ?? globalConsumes;
  const produces = (operation.produces as string[]) ?? globalProduces;

  const converted: Record<string, unknown> = {};

  // Copy simple fields
  for (const key of ['operationId', 'summary', 'description', 'tags', 'deprecated', 'security']) {
    if (operation[key] !== undefined) {
      converted[key] = operation[key];
    }
  }

  // Copy x- extension fields
  for (const key of Object.keys(operation)) {
    if (key.startsWith('x-')) {
      converted[key] = operation[key];
    }
  }

  // Separate body/formData params from regular params.
  // Before classifying, resolve any $ref entries against the global parameters map.
  const rawParams = (operation.parameters ?? []) as Record<string, unknown>[];
  const regularParams: Record<string, unknown>[] = [];
  let bodyParam: Record<string, unknown> | undefined;
  const formDataParams: Record<string, unknown>[] = [];

  for (const raw of rawParams) {
    // Inline any $ref to a global parameter before checking `.in`.
    const resolved = resolveParamRef(raw, globalParameters);
    if (resolved === null && raw.$ref !== undefined) {
      // resolveParamRef already warned; skip this unresolvable ref.
      continue;
    }
    const p = resolved ?? raw;

    if (p.in === 'body') {
      bodyParam = p;
    } else if (p.in === 'formData') {
      formDataParams.push(p);
    } else {
      regularParams.push(p);
    }
  }

  if (regularParams.length > 0) {
    converted.parameters = convertParameters(regularParams);
  }

  // Build requestBody from body param or formData params
  if (bodyParam) {
    const contentType = consumes[0] ?? 'application/json';
    converted.requestBody = {
      description: bodyParam.description,
      required: bodyParam.required ?? false,
      content: {
        [contentType]: {
          schema: convertSchemaRef(bodyParam.schema as Record<string, unknown>),
        },
      },
    };
  } else if (formDataParams.length > 0) {
    const hasFile = formDataParams.some((p) => p.type === 'file');
    const contentType = hasFile ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const p of formDataParams) {
      const name = p.name as string;
      if (p.type === 'file') {
        properties[name] = { type: 'string', format: 'binary' };
      } else {
        properties[name] = { type: p.type ?? 'string' };
        if (p.description) {
          (properties[name] as Record<string, unknown>).description = p.description;
        }
      }
      if (p.required) {
        required.push(name);
      }
    }

    converted.requestBody = {
      content: {
        [contentType]: {
          schema: {
            type: 'object',
            properties,
            ...(required.length > 0 ? { required } : {}),
          },
        },
      },
    };
  }

  // Convert responses
  const responses = (operation.responses ?? {}) as Record<string, Record<string, unknown>>;
  const convertedResponses: Record<string, unknown> = {};

  for (const [status, response] of Object.entries(responses)) {
    const convertedResponse: Record<string, unknown> = {
      description: response.description ?? '',
    };

    if (response.schema) {
      const contentType = produces[0] ?? 'application/json';
      convertedResponse.content = {
        [contentType]: {
          schema: convertSchemaRef(response.schema as Record<string, unknown>),
        },
      };
    }

    if (response.headers) {
      convertedResponse.headers = response.headers;
    }

    convertedResponses[status] = convertedResponse;
  }

  converted.responses = convertedResponses;

  return converted;
}

function convertParameters(params: unknown[]): unknown[] {
  return (params as Record<string, unknown>[]).map((p) => {
    const converted: Record<string, unknown> = {
      name: p.name,
      in: p.in,
    };
    if (p.required !== undefined) converted.required = p.required;
    if (p.description !== undefined) converted.description = p.description;

    // Build schema from Swagger 2.0 parameter type fields
    const schema: Record<string, unknown> = {};
    if (p.type) schema.type = p.type;
    if (p.format) schema.format = p.format;
    if (p.enum) schema.enum = p.enum;
    if (p.default !== undefined) schema.default = p.default;
    if (p.items) schema.items = p.items;
    if (p.minimum !== undefined) schema.minimum = p.minimum;
    if (p.maximum !== undefined) schema.maximum = p.maximum;

    converted.schema = Object.keys(schema).length > 0 ? schema : { type: 'string' };
    return converted;
  });
}

function convertParameterDefinitions(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(params)) {
    const p = param as Record<string, unknown>;
    if (p.in === 'body') {
      // Body parameters in definitions are unusual; skip them for components.parameters
      continue;
    }
    const converted: Record<string, unknown> = {
      name: p.name ?? name,
      in: p.in,
    };
    if (p.required !== undefined) converted.required = p.required;
    if (p.description !== undefined) converted.description = p.description;
    const schema: Record<string, unknown> = {};
    if (p.type) schema.type = p.type;
    if (p.format) schema.format = p.format;
    if (p.enum) schema.enum = p.enum;
    converted.schema = Object.keys(schema).length > 0 ? schema : { type: 'string' };
    result[name] = converted;
  }
  return result;
}

function convertSecurityDefinitions(defs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(defs)) {
    const d = def as Record<string, unknown>;
    switch (d.type) {
      case 'basic':
        result[name] = { type: 'http', scheme: 'basic' };
        break;
      case 'apiKey':
        result[name] = { type: 'apiKey', name: d.name, in: d.in };
        break;
      case 'oauth2': {
        const scheme: Record<string, unknown> = { type: 'oauth2', flows: {} };
        const flows = scheme.flows as Record<string, unknown>;
        const scopes = (d.scopes ?? {}) as Record<string, string>;

        switch (d.flow) {
          case 'implicit':
            flows.implicit = { authorizationUrl: d.authorizationUrl, scopes };
            break;
          case 'password':
            flows.password = { tokenUrl: d.tokenUrl, scopes };
            break;
          case 'application':
            flows.clientCredentials = { tokenUrl: d.tokenUrl, scopes };
            break;
          case 'accessCode':
            flows.authorizationCode = {
              authorizationUrl: d.authorizationUrl,
              tokenUrl: d.tokenUrl,
              scopes,
            };
            break;
        }
        result[name] = scheme;
        break;
      }
      default:
        result[name] = d;
    }
  }
  return result;
}

function convertSchemaRef(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return {};
  // Swagger 2.0 uses #/definitions/Foo, OpenAPI 3.0 uses #/components/schemas/Foo
  // Since we move definitions -> components.schemas, update $ref paths
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string') {
      result.$ref = value.replace('#/definitions/', '#/components/schemas/');
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = convertSchemaRef(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? convertSchemaRef(item as Record<string, unknown>)
          : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function loadOpenApiSpec(input: string): Promise<LoadResult> {
  // SSRF guard: vet a remote top-level spec URL before any fetch. Remote `$ref`s
  // are vetted per-URL by the guarded http resolver in guardedParserOptions.
  if (isHttpUrl(input)) {
    await assertPublicUrl(input);
  }

  // First, parse without dereferencing to check for Swagger 2.0
  const raw = (await SwaggerParser.parse(input, guardedParserOptions)) as Record<string, unknown>;

  let specToParse: string | Record<string, unknown> = input;

  if (isSwagger2(raw)) {
    specToParse = convertSwagger2ToOpenApi3(raw as unknown as Swagger2Doc);
  }

  const api = (await SwaggerParser.dereference(
    specToParse as OpenAPI.Document,
    guardedParserOptions,
  )) as OpenAPI.Document;
  return { api, specPath: input };
}
