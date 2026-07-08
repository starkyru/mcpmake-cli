/**
 * Pure normalizers that project each language's MCP output onto a canonical
 * shape so the parity suite can deep-compare across runtimes. No I/O here.
 *
 * The generators are honest about their per-language envelopes: zod-to-json-schema
 * (node/worker) adds `$schema` / `additionalProperties:false` and injects the
 * `jq_filter` / `idempotency_key` control args; pydantic (python) adds per-property
 * `title`, encodes optionals as `anyOf [T, {type:null}]` with `default: null`,
 * hoists nested models into `$defs`/`$ref`, renames non-identifier wire names
 * (`X-Request-Id` → `X_Request_Id`), and drops parameter descriptions. All of
 * that is envelope, not meaning — normalizeSchema strips it so what remains
 * (types, enums, bounds, required-ness, structure) must be IDENTICAL across
 * languages. A genuine semantic drift (a lost property, a changed type, a
 * loosened `required`) survives normalization and fails the deep-compare.
 */

export type JsonSchema = Record<string, unknown>;

/** Control args node/worker inject into every tool; absent from python. */
const CONTROL_ARGS = new Set(['jq_filter', 'idempotency_key']);

/** Per-language envelope keys that carry no cross-language meaning. */
const STRIP_KEYS = new Set(['$schema', 'title', 'format', 'default', 'description']);

/**
 * Canonical property-name form: pydantic renames wire names that are not valid
 * Python identifiers (`X-Request-Id` → `X_Request_Id`); fold `-` to `_` on both
 * sides so the same wire parameter lands on the same canonical key. (The actual
 * wire header keeps its original name in every language — that is asserted
 * separately via the recording upstream.)
 */
function canonicalKey(key: string): string {
  return key.replace(/-/g, '_');
}

/** Resolve a `#/$defs/Name` ref against the root schema's `$defs`, if present. */
function resolveRef(ref: unknown, defs: Record<string, unknown>): unknown {
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return undefined;
  return defs[ref.slice('#/$defs/'.length)];
}

function normalizeNode(value: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => normalizeNode(v, defs));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  let schema = value as JsonSchema;

  // Inline pydantic's `$ref: "#/$defs/Model"` (merging any sibling keys over the
  // referenced schema, e.g. a description sitting next to the $ref).
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, defs);
    if (resolved && typeof resolved === 'object') {
      const { $ref: _ref, ...siblings } = schema;
      schema = { ...(resolved as JsonSchema), ...siblings };
    }
  }

  // Collapse pydantic's optional encoding: anyOf [T, {type:'null'}] → T,
  // keeping any keys that sat beside the anyOf (they describe the property).
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
    const [a, b] = schema.anyOf as JsonSchema[];
    const isNull = (s: JsonSchema) =>
      s && typeof s === 'object' && s.type === 'null' && Object.keys(s).length === 1;
    const real = isNull(b) ? a : isNull(a) ? b : undefined;
    if (real) {
      const { anyOf: _anyOf, ...siblings } = schema;
      return normalizeNode({ ...real, ...siblings }, defs);
    }
  }

  const out: JsonSchema = {};
  for (const key of Object.keys(schema)) {
    if (STRIP_KEYS.has(key) || key === '$defs') continue;
    if (key === 'additionalProperties' && typeof schema[key] === 'boolean') continue;
    if (key === 'properties' && schema[key] && typeof schema[key] === 'object') {
      const props = schema[key] as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      for (const propName of Object.keys(props)) {
        if (CONTROL_ARGS.has(propName)) continue;
        normalized[canonicalKey(propName)] = normalizeNode(props[propName], defs);
      }
      out.properties = normalized;
      continue;
    }
    if (key === 'required' && Array.isArray(schema[key])) {
      const required = (schema[key] as unknown[])
        .filter((r): r is string => typeof r === 'string' && !CONTROL_ARGS.has(r))
        .map(canonicalKey)
        .sort();
      if (required.length > 0) out.required = required;
      continue;
    }
    out[key] = normalizeNode(schema[key], defs);
  }

  // Deterministic key order so deepEqual failures diff cleanly.
  const sorted: JsonSchema = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key];
  return sorted;
}

/** Normalize one JSON Schema to its canonical cross-language form. */
export function normalizeSchema(schema: unknown): unknown {
  const defs =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? (((schema as JsonSchema).$defs as Record<string, unknown> | undefined) ?? {})
      : {};
  return normalizeNode(schema, defs);
}

export interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Project a raw tools/list result onto the cross-language surface: name,
 * whitespace-collapsed description, canonical input schema. Per-language extras
 * (title, outputSchema, annotations, execution) are asymmetries asserted
 * separately against the ASYMMETRIES table — never silently compared here.
 */
export function normalizeToolsList(tools: RawTool[]): NormalizedTool[] {
  return tools
    .map((t) => ({
      name: t.name,
      description: (t.description ?? '').replace(/\s+/g, ' ').trim(),
      inputSchema: normalizeSchema(t.inputSchema),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse text as JSON when possible; otherwise return the trimmed text. */
export function tryParseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

export interface NormalizedToolCallResult {
  isError: boolean;
  content: Array<{ type: string; value: unknown }>;
}

/**
 * Canonical tool-call result: JSON text content is parsed (node pretty-prints
 * with 2-space indent, python with `indent=2` — the parsed values must match),
 * and `isError` is folded to a strict boolean. `structuredContent` is a
 * per-language extra (see ASYMMETRIES), deliberately not compared here.
 */
export function normalizeToolCallResult(r: {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}): NormalizedToolCallResult {
  return {
    isError: r.isError === true,
    content: (r.content ?? []).map((c) => ({ type: c.type, value: tryParseJson(c.text) })),
  };
}

export interface CanonicalUpstreamRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  apiKey: string | undefined;
  body: unknown;
}

/** Canonical view of a recorded upstream request (query keys sorted). */
export function canonicalUpstreamRequest(u: {
  method: string;
  path: string;
  query: Record<string, string>;
  apiKey: string | undefined;
  body: unknown;
}): CanonicalUpstreamRequest {
  const query: Record<string, string> = {};
  for (const key of Object.keys(u.query).sort()) query[key] = u.query[key];
  return { method: u.method.toUpperCase(), path: u.path, query, apiKey: u.apiKey, body: u.body };
}
