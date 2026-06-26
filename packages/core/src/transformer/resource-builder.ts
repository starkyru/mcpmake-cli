import type { OperationDescriptor } from '../types/index.js';
import type { ResourceDefinition, PromptDefinition } from '../types/index.js';
import { escapeTemplateLiteral, escapeStringLiteral, sanitizeIdentifier } from '../utils/sanitize.js';
import { toToolName } from './naming.js';

/**
 * The name a tool is actually REGISTERED under — must mirror buildToolDefinition
 * (tool-builder.ts) so workflow-prompt text references real tool names. An
 * `x-mcp-name` (set directly or by the Stainless translator) overrides the
 * operationId-derived name; without honoring it the prompt would point the model
 * at tools that do not exist. (Post-collision `_method`/`_2` suffixes applied by
 * buildAllTools are not visible here, so those rare colliding names may still
 * diverge — the systematic x-mcp-name case is what this resolves.)
 */
function registeredToolName(op: OperationDescriptor): string {
  const mcpName = op.mcpExtensions?.name;
  return mcpName ? sanitizeIdentifier(mcpName) : toToolName(op.operationId);
}

/**
 * Produce an RFC 6570-safe URI-template variable name from an arbitrary path
 * parameter wire name.
 *
 * RFC 6570 §2.3 allows `[A-Za-z0-9_]` (plus pct-encoded, but MCP SDK does
 * not support them). Chars outside that set are REPLACED with `_` — not
 * stripped — so that two distinct names (e.g. `user-id` and `userid`) do not
 * silently collapse to the same key. A leading digit gets a `_` prefix to keep
 * the result a valid JS identifier (the SDK uses the name as an object key).
 * An empty input after replacement is guarded to `_param`.
 */
function uriTemplateVar(name: string): string {
  let safe = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (!safe) return '_param';
  if (/^[0-9]/.test(safe)) safe = `_${safe}`;
  return safe;
}

/**
 * Generate MCP resources from GET operations.
 * - List endpoints (no path params) → static resources
 * - Detail endpoints (with path params) → URI template resources
 */
export function buildResources(operations: OperationDescriptor[]): ResourceDefinition[] {
  const resources: ResourceDefinition[] = [];
  // R11-B: guard against duplicate resource names. Two operationIds that
  // collapse to the same toToolName result would produce two
  // `server.resource('X', 'api://X', …)` calls, which the MCP SDK rejects with
  // "Resource X is already registered". Append _2, _3, … until unique; keep the
  // uri in sync with the final name so name and URI stay consistent.
  const claimedNames = new Set<string>();

  for (const op of operations) {
    // Operations dropped from the tool surface (x-mcp-emit: skip) must not leak
    // back in as resources — mirror buildAllTools' skip handling.
    if (op.mcpExtensions?.emit === 'skip') continue;
    if (op.method !== 'get') continue;

    const baseName = toToolName(op.operationId);

    // Deduplicate: if baseName is already claimed, try baseName_2, _3, …
    let name = baseName;
    if (claimedNames.has(name)) {
      let n = 2;
      while (claimedNames.has(`${baseName}_${n}`)) n++;
      name = `${baseName}_${n}`;
    }
    claimedNames.add(name);

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
      // emitted into the single-quoted `uri` literal using RFC-6570-safe var names.
      //
      // Build a per-param mapping in a single pass: rawWire (the literal `{name}`
      // token in op.path) → safeVar (unique RFC-6570-safe identifier used in both
      // the URI template and the variables[key] read in the handler).
      //
      // Dedup: two params whose safe names collide (e.g. `a.b` and `ab` both →
      // `a_b`… wait, `ab` → `ab`; actual collision: `a-b` and `a_b` both →
      // `a_b`) get a _2, _3, … suffix so the URI template never has duplicate
      // variables, which would cause the MCP SDK to overwrite one slot silently.
      const claimedVarNames = new Set<string>();
      const pathParamPairs = op.parameters
        .filter((p) => p.in === 'path')
        .map((p) => {
          const baseVar = uriTemplateVar(p.name);
          let safeVar = baseVar;
          if (claimedVarNames.has(safeVar)) {
            let n = 2;
            while (claimedVarNames.has(`${baseVar}_${n}`)) n++;
            safeVar = `${baseVar}_${n}`;
          }
          claimedVarNames.add(safeVar);
          return { rawWire: p.name, safeVar };
        });

      const uriTemplate = `api://${name}/${pathParamPairs.map(({ safeVar }) => `{${safeVar}}`).join('/')}`;

      // Pre-compute URL body to avoid Handlebars/curly-brace conflicts.
      // Resource handler receives (uri: URL, variables: Variables) — extract params
      // from the SDK-provided variables map (keyed by the same safeVar names used
      // in the URI template above, e.g. `{user_id}` → `variables['user_id']`).
      const urlLines: string[] = [];
      // op.path is interpolated into a BACKTICK template literal here, so it must
      // be escaped for that sink: escapeStringLiteral leaves backticks and `${}`
      // live, allowing expression evaluation (D-C2). Use escapeTemplateLiteral.
      urlLines.push(`      let url = \`\${config.baseUrl}${escapeTemplateLiteral(op.path)}\`;`);
      for (const { rawWire, safeVar } of pathParamPairs) {
        // rawWire is the literal token in op.path, e.g. `user-id` for `{user-id}`.
        // escapeStringLiteral escapes it for a single-quoted JS string literal.
        // safeVar is RFC-6570-safe ([A-Za-z0-9_] only), making it safe to embed
        // directly as an object property key in a single-quoted string literal.
        urlLines.push(
          `      url = url.replace('{${escapeStringLiteral(rawWire)}}', encodeURIComponent(String(variables['${safeVar}'] ?? '')));`,
        );
      }

      resources.push({
        name,
        uri: uriTemplate,
        path: op.path,
        description,
        isTemplate: true,
        templateParams: pathParamPairs.map(({ rawWire }) => rawWire),
        urlBody: urlLines.join('\n'),
      });
    }
  }

  return resources;
}

// Mirror of bodyEncodingFor's supported set in tool-builder.ts — an op with an
// unsupported request-body media type is skipped by buildAllTools, so it must
// not be referenced in a workflow prompt (the tool is never registered).
// Field path: op.requestBody?.contentType (RequestBodyDescriptor.contentType).
function hasSupportedBody(op: OperationDescriptor): boolean {
  const ct = op.requestBody?.contentType;
  if (!ct) return true; // no body → always built
  const base = ct.split(';', 1)[0].trim().toLowerCase();
  return (
    base === '' ||
    base === 'application/json' ||
    base.endsWith('+json') ||
    base === 'application/x-www-form-urlencoded' ||
    base === 'multipart/form-data'
  );
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

  // R11-C: guard against duplicate prompt names. Two tags that map to the same
  // toToolName result (e.g. "Orders" and "orders" both → "orders") would produce
  // two `server.prompt('orders_workflow', …)` calls → startup crash. Dedup with
  // the same _2, _3, … counter approach as buildAllTools / buildResources.
  const claimedPromptNames = new Set<string>();

  const prompts: PromptDefinition[] = [];
  for (const [tag, ops] of tagGroups) {
    // R11-A: exclude operations whose request-body media type is unsupported by
    // buildAllTools — those tools are never registered, so listing them in the
    // workflow prompt would reference non-existent tools.
    const registeredOps = ops.filter(hasSupportedBody);
    // R12-B: if every op in the tag was filtered out, don't register an empty
    // workflow prompt that references zero tools.
    if (registeredOps.length === 0) continue;

    const toolList = registeredOps
      .map((op) => `- ${registeredToolName(op)}: ${op.summary ?? op.path}`)
      .join('\\n');

    // R11-C: derive a unique prompt name.
    const baseName = `${toToolName(tag)}_workflow`;
    let promptName = baseName;
    if (claimedPromptNames.has(promptName)) {
      let n = 2;
      while (claimedPromptNames.has(`${baseName}_${n}`)) n++;
      promptName = `${baseName}_${n}`;
    }
    claimedPromptNames.add(promptName);

    prompts.push({
      // `name` is emitted into a single-quoted literal; the tag is untrusted
      // spec input, so derive a slug-safe name from it.
      name: promptName,
      description: escapeTemplateLiteral(`Work with ${tag} — available operations`),
      template: escapeTemplateLiteral(
        `You have the following ${tag} tools available:\\n${toolList}\\n\\nWhat would you like to do?`,
      ),
    });
  }

  return prompts;
}
