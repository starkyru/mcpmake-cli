import type { OpenAPIV3 } from 'openapi-types';
import type {
  OperationDescriptor,
  HttpMethod,
  ParameterDescriptor,
  RequestBodyDescriptor,
  ResponseDescriptor,
  SecurityRequirement,
  JsonSchema,
  McpExtensions,
} from '../types/index.js';

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export interface ExtractionResult {
  operations: OperationDescriptor[];
  baseUrl: string;
  securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>;
  info: { title: string; version: string; description?: string };
}

export function extractOperations(api: OpenAPIV3.Document): ExtractionResult {
  const operations: OperationDescriptor[] = [];
  const baseUrl = api.servers?.[0]?.url ?? '';
  const securitySchemes = (api.components?.securitySchemes ?? {}) as Record<
    string,
    OpenAPIV3.SecuritySchemeObject
  >;
  const globalSecurity = api.security ?? [];

  for (const [path, pathItem] of Object.entries(api.paths ?? {})) {
    if (!pathItem) continue;
    const item = pathItem as OpenAPIV3.PathItemObject;
    const pathParams = (item.parameters ?? []) as OpenAPIV3.ParameterObject[];

    for (const method of HTTP_METHODS) {
      const operation = item[method] as OpenAPIV3.OperationObject | undefined;
      if (!operation) continue;

      const opParams = (operation.parameters ?? []) as OpenAPIV3.ParameterObject[];
      const mergedParams = mergeParameters(pathParams, opParams);

      const operationId = operation.operationId ?? synthesizeOperationId(method, path);

      const mcpExtensions = extractMcpExtensions(operation as Record<string, unknown>);

      operations.push({
        operationId,
        method,
        path,
        summary: operation.summary,
        description: operation.description,
        tags: operation.tags ?? [],
        parameters: mergedParams.map(toParameterDescriptor),
        requestBody: extractRequestBody(
          operation.requestBody as OpenAPIV3.RequestBodyObject | undefined,
        ),
        responses: extractResponses(operation.responses as OpenAPIV3.ResponsesObject),
        security: extractSecurity(operation.security ?? globalSecurity),
        deprecated: operation.deprecated ?? false,
        mcpExtensions,
      });
    }
  }

  return {
    operations,
    baseUrl,
    securitySchemes,
    info: {
      title: api.info.title,
      version: api.info.version,
      description: api.info.description,
    },
  };
}

function mergeParameters(
  pathLevel: OpenAPIV3.ParameterObject[],
  opLevel: OpenAPIV3.ParameterObject[],
): OpenAPIV3.ParameterObject[] {
  const byKey = new Map<string, OpenAPIV3.ParameterObject>();
  for (const p of pathLevel) byKey.set(`${p.in}:${p.name}`, p);
  for (const p of opLevel) byKey.set(`${p.in}:${p.name}`, p); // op-level overrides
  return [...byKey.values()];
}

function toParameterDescriptor(p: OpenAPIV3.ParameterObject): ParameterDescriptor {
  return {
    name: p.name,
    in: p.in as ParameterDescriptor['in'],
    required: p.required ?? p.in === 'path',
    description: p.description,
    schema: (p.schema ?? { type: 'string' }) as JsonSchema,
  };
}

function extractRequestBody(
  body: OpenAPIV3.RequestBodyObject | undefined,
): RequestBodyDescriptor | undefined {
  if (!body?.content) return undefined;

  const preferredTypes = [
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ];

  let contentType: string | undefined;
  for (const ct of preferredTypes) {
    if (body.content[ct]) {
      contentType = ct;
      break;
    }
  }
  if (!contentType) {
    contentType = Object.keys(body.content)[0];
  }
  if (!contentType) return undefined;

  const mediaType = body.content[contentType];
  return {
    required: body.required ?? false,
    description: body.description,
    contentType,
    schema: (mediaType.schema ?? {}) as JsonSchema,
  };
}

function extractResponses(responses: OpenAPIV3.ResponsesObject): ResponseDescriptor[] {
  const result: ResponseDescriptor[] = [];
  for (const [statusCode, responseObj] of Object.entries(responses)) {
    const response = responseObj as OpenAPIV3.ResponseObject;
    let contentType: string | undefined;
    let schema: JsonSchema | undefined;

    if (response.content) {
      contentType = Object.keys(response.content)[0];
      if (contentType) {
        schema = response.content[contentType].schema as JsonSchema | undefined;
      }
    }

    result.push({
      statusCode,
      description: response.description,
      contentType,
      schema,
    });
  }
  return result;
}

function extractSecurity(security: OpenAPIV3.SecurityRequirementObject[]): SecurityRequirement[] {
  const result: SecurityRequirement[] = [];
  for (const req of security) {
    for (const [schemeName, scopes] of Object.entries(req)) {
      result.push({ schemeName, scopes });
    }
  }
  return result;
}

function synthesizeOperationId(method: string, path: string): string {
  const cleaned = path.replace(/[{}]/g, '').replace(/\//g, '_').replace(/^_/, '').replace(/_$/, '');
  return `${method}_${cleaned}`;
}

function extractMcpExtensions(operation: Record<string, unknown>): McpExtensions | undefined {
  const name = operation['x-mcp-name'] as string | undefined;
  const description = operation['x-mcp-description'] as string | undefined;
  const emit = operation['x-mcp-emit'] as McpExtensions['emit'] | undefined;
  const scope = operation['x-mcp-scope'] as McpExtensions['scope'] | undefined;
  const deprecationMessage = operation['x-mcp-deprecation-message'] as string | undefined;
  const deprecationReplacement = operation['x-mcp-deprecation-replacement'] as string | undefined;
  const jqFilter = operation['x-mcp-jq-filter'] as string | undefined;
  const unknownValues = operation['x-mcp-unknown-values'] as 'allow' | 'reject' | undefined;

  if (
    !name &&
    !description &&
    !emit &&
    !scope &&
    !deprecationMessage &&
    !deprecationReplacement &&
    !jqFilter &&
    !unknownValues
  ) {
    return undefined;
  }
  return {
    name,
    description,
    emit,
    scope,
    deprecationMessage,
    deprecationReplacement,
    jqFilter,
    unknownValues,
  };
}
