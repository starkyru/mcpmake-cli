import type { OperationDescriptor } from '../types/index.js';
import type { ResourceDefinition, PromptDefinition } from '../types/index.js';
import {
  escapeTemplateLiteral,
  escapeStringLiteral,
  sanitizeIdentifier,
} from '../utils/sanitize.js';
import { toToolName } from './naming.js';

/**
 * Generate MCP resources from GET operations.
 * - List endpoints (no path params) → static resources
 * - Detail endpoints (with path params) → URI template resources
 */
export function buildResources(operations: OperationDescriptor[]): ResourceDefinition[] {
  const resources: ResourceDefinition[] = [];

  for (const op of operations) {
    // Operations dropped from the tool surface (x-mcp-emit: skip) must not leak
    // back in as resources — mirror buildAllTools' skip handling.
    if (op.mcpExtensions?.emit === 'skip') continue;
    if (op.method !== 'get') continue;

    const name = toToolName(op.operationId);
    const description = escapeTemplateLiteral(
      op.summary ?? `${op.method.toUpperCase()} ${op.path}`,
    );

    if (!op.path.includes('{')) {
      // Static resource — list endpoint. `path` is emitted into a backtick URL
      // literal (`\`${config.baseUrl}<path>\``) in resources.ts.hbs, so escape it.
      resources.push({
        name,
        uri: `api://${name}`,
        path: escapeTemplateLiteral(op.path),
        description,
      });
    } else {
      // Template resource — detail endpoint with path params. Param names are
      // emitted into the single-quoted `uri` literal, so sanitize them.
      const pathParams = op.parameters.filter((p) => p.in === 'path').map((p) => p.name);
      const uriTemplate = `api://${name}/${pathParams.map((p) => `{${sanitizeIdentifier(p)}}`).join('/')}`;

      // Pre-compute URL body to avoid Handlebars/curly-brace conflicts.
      // Resource handler receives (uri: URL, extra) — extract params from uri.pathname.
      const urlLines: string[] = [];
      urlLines.push(`      const pathParts = uri.pathname.split('/').filter(Boolean);`);
      // op.path is interpolated into a BACKTICK template literal here, so it must
      // be escaped for that sink: escapeStringLiteral leaves backticks and `${}`
      // live, allowing expression evaluation (D-C2). Use escapeTemplateLiteral.
      urlLines.push(`      let url = \`\${config.baseUrl}${escapeTemplateLiteral(op.path)}\`;`);
      // Replace path params using positional extraction from the URI
      const pathSegments = op.path.split('/').filter(Boolean);
      for (let i = 0; i < pathSegments.length; i++) {
        const seg = pathSegments[i];
        if (seg.startsWith('{') && seg.endsWith('}')) {
          const safe = sanitizeIdentifier(seg.slice(1, -1));
          urlLines.push(
            `      if (pathParts[${i}]) url = url.replace('${escapeStringLiteral(seg)}', encodeURIComponent(pathParts[${i}]));`,
          );
        }
      }

      resources.push({
        name,
        uri: uriTemplate,
        path: op.path,
        description,
        isTemplate: true,
        templateParams: pathParams,
        urlBody: urlLines.join('\n'),
      });
    }
  }

  return resources;
}

/**
 * Generate MCP prompts — one per tag as a "workflow" prompt.
 */
export function buildPrompts(operations: OperationDescriptor[]): PromptDefinition[] {
  const tagGroups = new Map<string, OperationDescriptor[]>();
  for (const op of operations) {
    if (op.mcpExtensions?.emit === 'skip') continue;
    const tag = op.tags[0] ?? 'default';
    const existing = tagGroups.get(tag);
    if (existing) existing.push(op);
    else tagGroups.set(tag, [op]);
  }

  const prompts: PromptDefinition[] = [];
  for (const [tag, ops] of tagGroups) {
    const toolList = ops
      .map((op) => `- ${toToolName(op.operationId)}: ${op.summary ?? op.path}`)
      .join('\\n');
    prompts.push({
      // `name` is emitted into a single-quoted literal; the tag is untrusted
      // spec input, so derive a slug-safe name from it.
      name: `${toToolName(tag)}_workflow`,
      description: escapeTemplateLiteral(`Work with ${tag} — available operations`),
      template: escapeTemplateLiteral(
        `You have the following ${tag} tools available:\\n${toolList}\\n\\nWhat would you like to do?`,
      ),
    });
  }

  return prompts;
}
