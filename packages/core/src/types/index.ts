export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

export interface ParameterDescriptor {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface RequestBodyDescriptor {
  required: boolean;
  description?: string;
  contentType: string;
  schema: JsonSchema;
}

export interface ResponseDescriptor {
  statusCode: string;
  description?: string;
  contentType?: string;
  schema?: JsonSchema;
}

export interface SecurityRequirement {
  schemeName: string;
  scopes: string[];
}

export interface McpExtensions {
  name?: string;
  description?: string;
  emit?: 'tool' | 'resource' | 'prompt' | 'skip';
  scope?: 'read' | 'write' | 'destructive';
  /** Deprecation message surfaced in tool description */
  deprecationMessage?: string;
  /** Replacement tool name for deprecated operations */
  deprecationReplacement?: string;
  /** JQ filter expression to trim API responses before returning to agent */
  jqFilter?: string;
  /** Allow unknown enum values for forward compatibility */
  unknownValues?: 'allow' | 'reject';
}

export interface OperationDescriptor {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: ParameterDescriptor[];
  requestBody?: RequestBodyDescriptor;
  responses: ResponseDescriptor[];
  security: SecurityRequirement[];
  /**
   * True when the operation explicitly declares `security: []` (an empty array),
   * which per OpenAPI means the operation is PUBLIC — it overrides any global
   * security and MUST NOT have auth applied (D-H2). Distinct from `security`
   * simply being empty because nothing was declared anywhere (in which case the
   * legacy global-auth behavior is preserved).
   */
  securityOptional?: boolean;
  deprecated: boolean;
  mcpExtensions?: McpExtensions;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

/**
 * Maps a tool's MCP input key to the original wire parameter it drives. Keeping
 * the wire name separate from the input key lets the schema expose any name
 * (emitted as a JSON.stringify'd key) while the handler still sends the exact
 * upstream parameter name and routes it to the right place (path/query/header/
 * cookie). See D-H1 / D-H2.
 */
export interface ParamMapping {
  /** The key the agent supplies in the tool input. */
  inputKey: string;
  /** The original API parameter name sent upstream. */
  wireName: string;
  /** Where the parameter is applied on the upstream request. */
  in: 'path' | 'query' | 'header' | 'cookie';
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchemaCode: string;
  outputSchemaCode?: string;
  operationId: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams: string[];
  queryParams: string[];
  headerParams: string[];
  /**
   * MCP-input-key → wire-name/location mappings for every parameter. Drives the
   * generated handler's path/query/header/cookie assembly (D-H1/D-H2).
   */
  paramMappings: ParamMapping[];
  /** The input key under which the request body is exposed (`body`/`requestBody`). */
  bodyInputKey?: string;
  hasRequestBody: boolean;
  requestBodyContentType: string;
  /**
   * Body serialization the executor must apply for {@link requestBodyContentType}:
   * `json` → JSON.stringify, `form` → URLSearchParams, `multipart` → FormData.
   * Unsupported media types are rejected at generation time (D-H3).
   */
  bodyEncoding?: 'json' | 'form' | 'multipart';
  /**
   * Generated body of `buildHeaders(params)` — assembles header and cookie
   * parameters from the tool input into an upstream header record. Empty record
   * when the operation has no header/cookie params (D-H2).
   */
  buildHeadersBody: string;
  /**
   * JSON.stringify'd source-operation metadata ({method, path}) for the generated
   * test, so an untrusted path can never escape a comment/literal (D-C3).
   */
  operationMeta: string;
  fileName: string;
  functionName: string;
  buildUrlBody: string;
  annotations?: ToolAnnotations;
  isAsync?: boolean;
  isDestructive?: boolean;
  /** JQ filter to apply to API response before returning to agent */
  jqFilter?: string;
  /**
   * Per-operation outbound-auth requirement, derived from the operation's
   * OpenAPI `security` (D-H2). Controls which configured auth scheme(s) the
   * generated handler applies to the upstream request:
   *   - `undefined` → apply all configured schemes (legacy global behavior).
   *   - `mode: 'public'` → apply NO auth (operation declared `security: []`).
   *   - `mode: 'schemes'` → apply ONLY the listed OpenAPI scheme names.
   * The OR/AND matrix is collapsed to the union of every alternative's scheme
   * names (any configured scheme that satisfies some alternative is applied);
   * full alternative-by-alternative selection is deferred.
   */
  authRequirement?: ToolAuthRequirement;
}

export type ToolAuthRequirement = { mode: 'public' } | { mode: 'schemes'; schemeNames: string[] };

export type AuthType = 'apiKey' | 'http-bearer' | 'http-basic' | 'oauth2';

export interface AuthScheme {
  type: AuthType;
  envVarName: string;
  headerName?: string;
  in?: 'header' | 'query' | 'cookie';
  description?: string;
  /**
   * The original OpenAPI security-scheme name (the key under
   * `components.securitySchemes`). Lets per-operation security requirements
   * (D-H2) select a specific scheme by name in the generated auth application.
   * Optional for sources (HAR) that have no named schemes.
   */
  schemeName?: string;
}

export interface EnvVarDescriptor {
  name: string;
  description: string;
  required: boolean;
  example?: string;
}

export type TransportMode = 'stdio' | 'http';

/**
 * Deployment target for the generated TypeScript server.
 * `node` (default) emits a Node.js server (stdio or node:http); `cloudflare`
 * emits a stateless Cloudflare Workers Fetch handler.
 */
export type EmitTarget = 'node' | 'cloudflare';

export interface ResourceDefinition {
  name: string;
  uri: string;
  path: string;
  description: string;
  isTemplate?: boolean;
  templateParams?: string[];
  urlBody?: string;
}

export interface PromptDefinition {
  name: string;
  description: string;
  template: string;
}

export interface ProjectManifest {
  serverName: string;
  serverVersion: string;
  baseUrl: string;
  transport: TransportMode;
  tools: ToolDefinition[];
  resources?: ResourceDefinition[];
  prompts?: PromptDefinition[];
  authSchemes: AuthScheme[];
  envVars: EnvVarDescriptor[];
  dynamicDiscovery?: boolean;
  staticToolCount?: number;
  /** Deployment target (default `node`). `cloudflare` emits a Workers project. */
  target?: EmitTarget;
  /**
   * Named base URLs to pre-seed into the generated `.env.example` as
   * `MCP_ENVIRONMENTS` (a JSON name→URL map). Used by the Stainless importer to
   * carry over a config's `environments`. Optional — omitted from normal output.
   */
  environments?: Record<string, string>;
  /** The environment selected by default (`API_ENVIRONMENT`). */
  defaultEnvironment?: string;
}

export type JsonSchema = Record<string, unknown>;
