/**
 * The KNOWN cross-language asymmetries of the generated servers, as a single
 * feature × language truth table. The parity suite asserts this table in BOTH
 * directions: a feature a language is supposed to have must be present, and a
 * feature it is supposed to lack must be absent. Any drift — a gap silently
 * closing or a capability silently regressing — fails the suite until this
 * table is updated to match the new INTENDED behavior.
 *
 * Every entry below was verified empirically (generate + run + capture raw
 * tools/list + tools/call against the built CLI), not guessed from templates.
 */

export type ParityLang = 'node-stdio' | 'node-http' | 'worker' | 'python';

export interface LangFeatures {
  /** jq_filter + idempotency_key control args injected into every inputSchema. */
  controlArgs: boolean;
  /** tools/list entries carry a human `title` ("List Widgets"). */
  toolTitle: boolean;
  /**
   * tools/list entries carry an `outputSchema`. Note: node's is API-derived
   * (from the OpenAPI response schema, array roots wrapped as {items});
   * python's is FastMCP's generic `list[TextContent]` wrapper keyed `result` —
   * present, but NOT derived from the API. The suite asserts that distinction.
   */
  outputSchema: boolean;
  /** Successful tools/call results include `structuredContent`. */
  structuredContent: boolean;
  /** tools/list entries carry `annotations` (readOnlyHint / destructiveHint). */
  annotations: boolean;
  /** An upstream 4xx/5xx surfaces as `isError: true` on the tool result. */
  upstreamErrorIsError: boolean;
  /** MCP_TOOLS / MCP_EXCLUDE_TOOLS runtime tool filtering is honored. */
  toolFiltering: boolean;
  /** The server can speak Streamable HTTP (POST /mcp) in addition to stdio. */
  httpTransport: boolean;
}

export const ASYMMETRIES: Record<ParityLang, LangFeatures> = {
  'node-stdio': {
    controlArgs: true,
    toolTitle: true,
    outputSchema: true,
    structuredContent: true,
    annotations: true,
    upstreamErrorIsError: true,
    toolFiltering: true,
    httpTransport: true,
  },
  'node-http': {
    controlArgs: true,
    toolTitle: true,
    outputSchema: true,
    structuredContent: true,
    annotations: true,
    upstreamErrorIsError: true,
    toolFiltering: true,
    httpTransport: true,
  },
  worker: {
    controlArgs: true,
    toolTitle: true,
    outputSchema: false,
    structuredContent: false,
    annotations: true,
    upstreamErrorIsError: true,
    toolFiltering: true,
    httpTransport: true,
  },
  python: {
    controlArgs: false,
    toolTitle: false,
    // FastMCP synthesizes a generic list[TextContent] outputSchema (and echoes
    // structuredContent {result: [...]}) for every tool — present but generic.
    outputSchema: true,
    structuredContent: true,
    annotations: false,
    // Upstream errors come back as ordinary text content with isError absent.
    upstreamErrorIsError: false,
    toolFiltering: false,
    httpTransport: false,
  },
};

/**
 * Exact upstream-404 error text per language, verified against the generated
 * runtimes (templates/tool-handler.ts.hbs + http-executor.ts.hbs render
 * `Error: ${status} ${statusText}`; python-templates/server.py.hbs renders
 * `Error: upstream returned {status} {reason_phrase}` — python deliberately
 * hides the upstream body and says "upstream returned" instead).
 */
export const UPSTREAM_ERROR_TEXT: Record<ParityLang, RegExp> = {
  'node-stdio': /^Error: 404 Not Found$/,
  'node-http': /^Error: 404 Not Found$/,
  worker: /^Error: 404 Not Found$/,
  python: /^Error: upstream returned 404 Not Found$/,
};
