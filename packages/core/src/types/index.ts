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
  deprecated: boolean;
  mcpExtensions?: McpExtensions;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
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
  hasRequestBody: boolean;
  requestBodyContentType: string;
  fileName: string;
  functionName: string;
  buildUrlBody: string;
  annotations?: ToolAnnotations;
  isAsync?: boolean;
  isDestructive?: boolean;
  /** JQ filter to apply to API response before returning to agent */
  jqFilter?: string;
}

export type AuthType = 'apiKey' | 'http-bearer' | 'http-basic' | 'oauth2';

export interface AuthScheme {
  type: AuthType;
  envVarName: string;
  headerName?: string;
  in?: 'header' | 'query' | 'cookie';
  description?: string;
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
