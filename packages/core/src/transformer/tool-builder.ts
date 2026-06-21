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
import { logger } from '../utils/logger.js';
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
  const { code: inputSchemaCode, mappings, bodyInputKey } = buildOperationInputSchema(op);

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
  // The replace TARGET must match the token as it appears in the sanitized URL
  // string (produced by sanitizePathTemplate, which keeps [a-zA-Z0-9/{}._-]
  // globally — inside braces the effective keep-set is [a-zA-Z0-9._-]).  Apply
  // the same in-brace strip to wireName so the target always matches the token
  // even for names with spaces, '@', ':', ';', etc. (R17-A).  Names with only
  // kept chars (e.g. `user.id`, `petId`) are unaffected — tokenName === wireName
  // for those (preserves R16-A fix for dots/dashes).
  for (const m of mappings.filter((p) => p.in === 'path')) {
    const tokenName = m.wireName.replace(/[^a-zA-Z0-9._\-]/g, '');
    lines.push(
      `  url = url.replace('${escapeStringLiteral(`{${tokenName}}`)}', encodeURIComponent(String(params[${JSON.stringify(m.inputKey)}])));`,
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

  // Build each tool individually so that one operation with an unsupported body
  // media type (e.g. application/xml, text/plain) does not abort the entire run.
  // bodyEncodingFor intentionally throws for unsupported content types (D-H3);
  // we catch that error here, warn with the operation identity, and skip only
  // the affected operation — all others proceed normally.
  const tools: ToolDefinition[] = [];
  for (const op of filtered) {
    try {
      tools.push(buildToolDefinition(op));
    } catch (err) {
      const label = op.operationId || `${op.method} ${op.path}`;
      logger.warn(
        `Skipping operation "${label}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // First pass: disambiguate name collisions by appending the HTTP method. This
  // keeps the common case (distinct operationIds → distinct names) stable.
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

  // Second pass: two operations sharing the same operationId AND method still
  // collide after the first pass; appending the method does not disambiguate
  // them, so the later tool would silently overwrite the earlier one's name and
  // output file (M14). Append an incrementing `_2`, `_3`, … suffix to each later
  // collision so every tool name — and therefore its file name — is globally
  // unique. Names that did not collide are left untouched.
  //
  // Pre-seed the four dynamic-discovery meta-tool names (R16-C). In hybrid mode
  // (staticToolCount > 0 + dynamicDiscovery), both the static tools and these
  // meta-tools are registered on the same MCP server. An operation whose slug
  // collides with one of them would cause a duplicate server.registerTool() call
  // and a startup crash. Seeding here ensures such an operation gets a `_2` suffix
  // before it reaches the template. Seeding unconditionally is harmless: when
  // dynamic discovery is off the reserved names simply never appear as tool names.
  const usedNames = new Set<string>([
    'list_tools',
    'get_tool_schema',
    'execute_tool',
    'search_tools',
  ]);
  const usedFileNames = new Set<string>();
  for (const tool of tools) {
    if (!usedNames.has(tool.name) && !usedFileNames.has(tool.fileName)) {
      usedNames.add(tool.name);
      usedFileNames.add(tool.fileName);
      continue;
    }
    let n = 2;
    let name = `${tool.name}_${n}`;
    let fileName = `${tool.fileName}-${n}`;
    while (usedNames.has(name) || usedFileNames.has(fileName)) {
      n++;
      name = `${tool.name}_${n}`;
      fileName = `${tool.fileName}-${n}`;
    }
    tool.name = name;
    tool.fileName = fileName;
    tool.functionName = `${tool.functionName}${n}`;
    usedNames.add(name);
    usedFileNames.add(fileName);
  }

  // Enforce MCP spec name length limit (128 chars). Truncation is applied after
  // the dedup pass, so two names that are distinct only beyond character 128 would
  // re-collide here (R19-B). Re-check uniqueness after each truncation: on
  // collision append a numeric suffix (`_2`, `_3`, …) and re-truncate so the
  // final name is both ≤128 chars and globally unique. The common case (name
  // already ≤128 chars) is unchanged — no suffix, no re-check needed.
  const truncatedNames = new Set<string>();
  for (const tool of tools) {
    const truncated = tool.name.slice(0, 128);
    if (!truncatedNames.has(truncated)) {
      tool.name = truncated;
      truncatedNames.add(truncated);
      continue;
    }
    // Collision after truncation: find the next free suffixed name that fits in
    // 128 chars. The base is re-sliced to leave room for the suffix.
    let n = 2;
    let suffix = `_${n}`;
    let name = truncated.slice(0, 128 - suffix.length) + suffix;
    while (truncatedNames.has(name)) {
      n++;
      suffix = `_${n}`;
      name = truncated.slice(0, 128 - suffix.length) + suffix;
    }
    tool.name = name;
    truncatedNames.add(name);
  }

  return tools;
}
