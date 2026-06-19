import type { OperationDescriptor, ToolDefinition, HttpMethod } from '../types/index.js';
import {
  buildOperationInputSchema,
  jsonSchemaToZodCode,
  jsonSchemaToOutputZodCode,
} from '../parser/schema-converter.js';
import { toToolName, toToolTitle, toFileName, toFunctionName } from './naming.js';
import {
  escapeTemplateLiteral,
  escapeStringLiteral,
  sanitizeIdentifier,
  sanitizePathTemplate,
} from '../utils/sanitize.js';

export function buildToolDefinition(op: OperationDescriptor): ToolDefinition {
  const inputSchemaCode = buildOperationInputSchema(op);

  const descParts: string[] = [];
  if (op.summary) descParts.push(op.summary);
  if (op.description && op.description !== op.summary) descParts.push(op.description);
  if (op.deprecated) descParts.push('[DEPRECATED]');
  if (op.mcpExtensions?.deprecationMessage) {
    descParts.push(`[DEPRECATED: ${op.mcpExtensions.deprecationMessage}]`);
  }
  if (op.mcpExtensions?.deprecationReplacement) {
    descParts.push(`Use ${op.mcpExtensions.deprecationReplacement} instead.`);
  }
  const description = escapeTemplateLiteral(
    descParts.join(' — ') || `${op.method.toUpperCase()} ${op.path}`,
  );

  const pathParams = op.parameters.filter((p) => p.in === 'path').map((p) => p.name);
  const queryParams = op.parameters.filter((p) => p.in === 'query').map((p) => p.name);

  // Apply x-mcp-* extension overrides
  const mcpName = op.mcpExtensions?.name;
  const mcpDesc = op.mcpExtensions?.description;

  // Output schema from 200 response
  const successResponse = op.responses.find(
    (r) => r.statusCode === '200' || r.statusCode === '201',
  );
  const outputSchemaCode = successResponse?.schema
    ? jsonSchemaToOutputZodCode(successResponse.schema)
    : undefined;

  // Annotations from HTTP method semantics
  const annotations = buildAnnotations(op.method);

  return {
    name: mcpName ? sanitizeIdentifier(mcpName) : toToolName(op.operationId),
    title: mcpName ? mcpName : toToolTitle(op.operationId),
    description: mcpDesc ? escapeTemplateLiteral(mcpDesc) : description,
    inputSchemaCode,
    outputSchemaCode,
    operationId: op.operationId,
    method: op.method,
    pathTemplate: op.path,
    pathParams,
    queryParams,
    headerParams: op.parameters.filter((p) => p.in === 'header').map((p) => p.name),
    hasRequestBody: !!op.requestBody,
    requestBodyContentType: op.requestBody?.contentType ?? 'application/json',
    fileName: toFileName(op.operationId),
    functionName: toFunctionName(op.operationId),
    buildUrlBody: generateBuildUrlBody(op.path, pathParams, queryParams),
    annotations,
    isAsync: op.responses.some((r) => r.statusCode === '202'),
    isDestructive: op.method === 'delete',
    // Escaped because it is emitted into a single-quoted string literal
    // (`applyJqFilter(result, '<jqFilter>')`) in the tool-handler template.
    jqFilter: op.mcpExtensions?.jqFilter
      ? escapeStringLiteral(op.mcpExtensions.jqFilter)
      : undefined,
  };
}

function buildAnnotations(method: HttpMethod): ToolDefinition['annotations'] {
  switch (method) {
    case 'get':
    case 'head':
    case 'options':
      return { readOnlyHint: true };
    case 'delete':
      return { destructiveHint: true };
    case 'put':
      return { idempotentHint: true };
    default:
      return undefined;
  }
}

function generateBuildUrlBody(
  pathTemplate: string,
  pathParams: string[],
  queryParams: string[],
): string {
  const safePath = sanitizePathTemplate(pathTemplate);
  const lines: string[] = [];
  lines.push(`  let url = baseUrl + '${escapeStringLiteral(safePath)}';`);

  for (const p of pathParams) {
    const safeP = sanitizeIdentifier(p);
    lines.push(
      `  url = url.replace('${escapeStringLiteral(`{${safeP}}`)}', encodeURIComponent(String(params['${escapeStringLiteral(safeP)}'])));`,
    );
  }

  if (queryParams.length > 0) {
    lines.push('  const query = new URLSearchParams();');
    for (const q of queryParams) {
      const safeQ = sanitizeIdentifier(q);
      lines.push(
        `  if (params['${escapeStringLiteral(safeQ)}'] !== undefined) query.set('${escapeStringLiteral(safeQ)}', String(params['${escapeStringLiteral(safeQ)}']));`,
      );
    }
    lines.push('  const qs = query.toString();');
    lines.push('  return qs ? `${url}?${qs}` : url;');
  } else {
    lines.push('  return url;');
  }

  return lines.join('\n');
}

export function buildAllTools(operations: OperationDescriptor[]): ToolDefinition[] {
  // Filter out operations marked with x-mcp-emit: skip
  const filtered = operations.filter((op) => op.mcpExtensions?.emit !== 'skip');
  const tools = filtered.map(buildToolDefinition);

  // Handle name collisions by appending method
  const nameCount = new Map<string, number>();
  for (const t of tools) {
    nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1);
  }

  for (const tool of tools) {
    if ((nameCount.get(tool.name) ?? 0) > 1) {
      tool.name = `${tool.name}_${tool.method}`;
      tool.fileName = `${tool.fileName}-${tool.method}`;
      tool.functionName = `${tool.functionName}${tool.method.charAt(0).toUpperCase() + tool.method.slice(1)}`;
    }
  }

  // Enforce MCP spec name length limit (128 chars)
  for (const tool of tools) {
    if (tool.name.length > 128) {
      tool.name = tool.name.slice(0, 128);
    }
  }

  return tools;
}
