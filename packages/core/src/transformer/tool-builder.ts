import type {
  OperationDescriptor,
  ToolDefinition,
  HttpMethod,
  ParamMapping,
  ToolAuthRequirement,
} from '../types/index.js';
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
  sanitizeMediaType,
} from '../utils/sanitize.js';

/**
 * Map a (sanitized) media type to the body serialization the executor applies.
 * Anything outside the three supported families is rejected at generation time
 * rather than emitting a tool that mislabels JSON bytes as a form/upload (D-H3).
 */
function bodyEncodingFor(contentType: string): 'json' | 'form' | 'multipart' {
  const base = contentType.split(';', 1)[0].trim().toLowerCase();
  if (base === 'application/x-www-form-urlencoded') return 'form';
  if (base === 'multipart/form-data') return 'multipart';
  if (base === 'application/json' || base.endsWith('+json') || base === '') return 'json';
  throw new Error(
    `Unsupported request body media type "${contentType}". Supported: application/json, ` +
      `application/x-www-form-urlencoded, multipart/form-data.`,
  );
}

export function buildToolDefinition(op: OperationDescriptor): ToolDefinition {
  const { code: inputSchemaCode, mappings } = buildOperationInputSchema(op);

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

  // Request body media type: the OpenAPI content-map key is attacker-influenced
  // and is emitted into a single-quoted literal. Validate it as an RFC media type
  // (replacing anything malformed with application/json) and escape it for the
  // literal sink (D-C1). bodyEncodingFor rejects unsupported families (D-H3).
  const rawContentType = sanitizeMediaType(op.requestBody?.contentType ?? 'application/json');
  const bodyEncoding = op.requestBody ? bodyEncodingFor(rawContentType) : undefined;

  // The request body is exposed under `body`, unless a parameter already claimed
  // that input key, in which case the schema falls back to `requestBody`.
  const inputKeys = new Set(mappings.map((m) => m.inputKey));
  const bodyInputKey = op.requestBody
    ? inputKeys.has('body')
      ? 'requestBody'
      : 'body'
    : undefined;

  return {
    name: mcpName ? sanitizeIdentifier(mcpName) : toToolName(op.operationId),
    // Escaped because it is emitted into a single-quoted string literal
    // (`title: '<title>'`) in the tool-handler templates. x-mcp-name is
    // untrusted spec input, and the operationId fallback is now slug-safe.
    title: escapeStringLiteral(mcpName ? mcpName : toToolTitle(op.operationId)),
    description: mcpDesc ? escapeTemplateLiteral(mcpDesc) : description,
    inputSchemaCode,
    outputSchemaCode,
    operationId: op.operationId,
    method: op.method,
    pathTemplate: op.path,
    pathParams,
    queryParams,
    headerParams: op.parameters.filter((p) => p.in === 'header').map((p) => p.name),
    paramMappings: mappings,
    bodyInputKey,
    hasRequestBody: !!op.requestBody,
    // Escaped for the single-quoted `contentType: '...'` literal sink.
    requestBodyContentType: escapeStringLiteral(rawContentType),
    bodyEncoding,
    // JSON.stringify'd so a path with newlines/quotes is inert in the test file.
    operationMeta: JSON.stringify({ method: op.method, path: op.path }),
    buildHeadersBody: generateBuildHeadersBody(mappings),
    fileName: toFileName(op.operationId),
    functionName: toFunctionName(op.operationId),
    buildUrlBody: generateBuildUrlBody(op.path, mappings),
    annotations,
    isAsync: op.responses.some((r) => r.statusCode === '202'),
    isDestructive: op.method === 'delete',
    // Escaped because it is emitted into a single-quoted string literal
    // (`applyJqFilter(result, '<jqFilter>')`) in the tool-handler template.
    jqFilter: op.mcpExtensions?.jqFilter
      ? escapeStringLiteral(op.mcpExtensions.jqFilter)
      : undefined,
    authRequirement: deriveAuthRequirement(op),
  };
}

/**
 * Map an operation's OpenAPI `security` onto the generated handler's outbound
 * auth requirement (D-H2):
 *   - explicit `security: []` → public (no auth applied);
 *   - one or more named schemes → apply only those scheme names (the OR/AND
 *     matrix is collapsed to the union of every alternative's scheme names);
 *   - nothing declared → `undefined` so the legacy global-auth behavior (apply
 *     every configured scheme) is preserved and existing specs are unaffected.
 */
function deriveAuthRequirement(op: OperationDescriptor): ToolAuthRequirement | undefined {
  if (op.securityOptional) return { mode: 'public' };
  if (op.security.length === 0) return undefined;
  // De-duplicate scheme names while preserving first-seen order.
  const seen = new Set<string>();
  const schemeNames: string[] = [];
  for (const req of op.security) {
    if (req.schemeName && !seen.has(req.schemeName)) {
      seen.add(req.schemeName);
      schemeNames.push(req.schemeName);
    }
  }
  if (schemeNames.length === 0) return undefined;
  return { mode: 'schemes', schemeNames };
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

/**
 * Generate the body of `buildHeaders(params)`. Header parameters are set
 * directly; cookie parameters are collected into a single `Cookie` header.
 * Both read by inputKey and send under the original wire name (D-H2). Returns
 * `return {};` when the operation has no header/cookie params.
 */
function generateBuildHeadersBody(mappings: ParamMapping[]): string {
  const headerMappings = mappings.filter((p) => p.in === 'header');
  const cookieMappings = mappings.filter((p) => p.in === 'cookie');
  if (headerMappings.length === 0 && cookieMappings.length === 0) {
    return '  return {};';
  }

  const lines: string[] = [];
  lines.push('  const headers: Record<string, string> = {};');
  for (const m of headerMappings) {
    lines.push(
      `  if (params[${JSON.stringify(m.inputKey)}] !== undefined) headers['${escapeStringLiteral(m.wireName)}'] = String(params[${JSON.stringify(m.inputKey)}]);`,
    );
  }
  if (cookieMappings.length > 0) {
    lines.push('  const cookieParts: string[] = [];');
    for (const m of cookieMappings) {
      lines.push(
        `  if (params[${JSON.stringify(m.inputKey)}] !== undefined) cookieParts.push('${escapeStringLiteral(m.wireName)}=' + encodeURIComponent(String(params[${JSON.stringify(m.inputKey)}])));`,
      );
    }
    lines.push("  if (cookieParts.length > 0) headers['Cookie'] = cookieParts.join('; ');");
  }
  lines.push('  return headers;');
  return lines.join('\n');
}

function generateBuildUrlBody(pathTemplate: string, mappings: ParamMapping[]): string {
  const safePath = sanitizePathTemplate(pathTemplate);
  const lines: string[] = [];
  lines.push(`  let url = baseUrl + '${escapeStringLiteral(safePath)}';`);

  // Path params: replace the `{wireName}` token in the URL with the value the
  // agent supplied under inputKey (D-H1 — read by inputKey, send under wireName).
  for (const m of mappings.filter((p) => p.in === 'path')) {
    const safeWire = sanitizeIdentifier(m.wireName);
    lines.push(
      `  url = url.replace('${escapeStringLiteral(`{${safeWire}}`)}', encodeURIComponent(String(params[${JSON.stringify(m.inputKey)}])));`,
    );
  }

  const queryMappings = mappings.filter((p) => p.in === 'query');
  if (queryMappings.length > 0) {
    lines.push('  const query = new URLSearchParams();');
    for (const m of queryMappings) {
      // Read by inputKey, send under the original wire name (D-H1).
      lines.push(
        `  if (params[${JSON.stringify(m.inputKey)}] !== undefined) query.set('${escapeStringLiteral(m.wireName)}', String(params[${JSON.stringify(m.inputKey)}]));`,
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
