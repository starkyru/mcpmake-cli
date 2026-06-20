/**
 * Translate a parsed Stainless config into mcpmake's overlay model by mutating
 * the in-memory OpenAPI document, then return the structural knobs the command
 * threads into generation (base URL / environments / auth override) plus a
 * human-readable migration report.
 *
 * The mutation strategy is deliberate: mcpmake already honours `x-mcp-*`
 * operation extensions (see `parser/operation-extractor.ts`), so injecting them
 * onto the spec before extraction is the lowest-risk way to reproduce Stainless
 * behaviour without a parallel override pipeline. Everything here is pure data —
 * the only side effect is setting string-valued `x-mcp-*` keys on operations.
 */
import type { OpenAPIV3 } from 'openapi-types';
import type {
  StainlessConfig,
  StainlessResource,
  StainlessMethodValue,
} from './stainless-config.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export interface AuthOverride {
  /** Pin the generated server to this OpenAPI security scheme (vs. emitting all). */
  schemeName?: string;
  /** Read the credential from this env var instead of mcpmake's default name. */
  envVarName?: string;
}

export interface StainlessTranslation {
  /** Map of `METHOD /path` → derived tool name, for the report and tests. */
  toolNames: Record<string, string>;
  /** Named base URLs to seed into the generated `MCP_ENVIRONMENTS`. */
  environments?: Record<string, string>;
  /** The environment selected by default (e.g. `production`). */
  defaultEnvironment?: string;
  /** Base URL chosen from the default environment (overrides the spec's). */
  baseUrl?: string;
  authOverride?: AuthOverride;
  /** `METHOD /path` keys whose response was given an unwrap `jq` filter. */
  unwrapped: string[];
  /** `METHOD /path` keys dropped from the MCP tool surface. */
  skipped: string[];
  /** Stainless's 2-tool code-execution default was detected. */
  codeMode: boolean;
  docsSearch: boolean;
  warnings: string[];
  report: string[];
}

type AnyOperation = Record<string, unknown>;

/**
 * Mutates `api` in place (adding `x-mcp-*` extensions) and returns the derived
 * generation knobs + migration report.
 */
export function translateStainless(
  config: StainlessConfig,
  api: OpenAPIV3.Document,
): StainlessTranslation {
  const warnings: string[] = [];
  const report: string[] = [];
  const toolNames: Record<string, string> = {};
  const skipped: string[] = [];
  const unwrapped: string[] = [];

  // Distinct resources can singularize to the same name (e.g. `users` and
  // `user`, both → `list_user`). buildAllTools' collision handler only appends
  // the HTTP method, which still collides when the verb matches — so make the
  // names we assign unique up front by suffixing `_2`, `_3`, …
  const assignedNames = new Set<string>();
  const claimName = (base: string): string => {
    let name = base;
    for (let n = 2; assignedNames.has(name); n++) name = `${base}_${n}`;
    assignedNames.add(name);
    return name;
  };

  // 1. Resource-tree-driven naming → x-mcp-name (the headline parity item).
  if (config.resources && typeof config.resources === 'object') {
    walkResources(config.resources, [], (methodName, value, chain) => {
      const ptr = parseMethodPointer(value);
      const op = locateOperation(api, ptr);
      if (!op) {
        warnings.push(
          `Resource method "${chain.join('.')}.${methodName}" did not match any operation in the spec — skipped.`,
        );
        return;
      }
      const key = ptr.method && ptr.path ? `${ptr.method.toUpperCase()} ${ptr.path}` : opKey(op);
      if (isMethodSkipped(value)) {
        op['x-mcp-emit'] = 'skip';
        skipped.push(key);
        return;
      }
      const derived = toolNameFromTree(methodName, chain);
      if (derived && !op['x-mcp-name']) {
        const name = claimName(derived);
        op['x-mcp-name'] = name;
        toolNames[key] = name;
      }
    });
  }

  // 1b. Fallback: resource/method encoded as `x-stainless-*` operation extensions
  // (common when the tree lives in the spec rather than the config).
  forEachOperation(api, (op, method, path) => {
    const key = `${method.toUpperCase()} ${path}`;
    const sResource =
      typeof op['x-stainless-resource'] === 'string'
        ? (op['x-stainless-resource'] as string)
        : undefined;
    const sMethod =
      typeof op['x-stainless-method-name'] === 'string'
        ? (op['x-stainless-method-name'] as string)
        : undefined;
    if (isStainlessSkipped(op)) {
      if (op['x-mcp-emit'] !== 'skip') {
        op['x-mcp-emit'] = 'skip';
        skipped.push(key);
      }
      return;
    }
    if (sResource && sMethod && !op['x-mcp-name']) {
      const derived = toolNameFromTree(sMethod, sResource.split('.').filter(Boolean));
      if (derived) {
        const name = claimName(derived);
        op['x-mcp-name'] = name;
        toolNames[key] = name;
      }
    }
  });

  // 2. unwrap_response → x-mcp-jq-filter on the success response.
  const unwrap = config.settings?.unwrap_response;
  if (unwrap) {
    // A string names the envelope property. Validate it to a safe dotted path —
    // the value is emitted into a generated `applyJqFilter(result, '.<prop>')`
    // call, so reject anything that could break out of that string literal.
    let explicitProp: string | undefined;
    if (typeof unwrap === 'string') {
      const candidate = unwrap.replace(/^\./, '').trim();
      if (/^[A-Za-z0-9_.]+$/.test(candidate)) {
        explicitProp = candidate;
      } else {
        warnings.push(
          `Ignoring settings.unwrap_response "${unwrap}" — not a simple property path ([A-Za-z0-9_.]).`,
        );
      }
    }
    if (typeof unwrap !== 'string' || explicitProp) {
      forEachOperation(api, (op, method, path) => {
        if (op['x-mcp-emit'] === 'skip' || op['x-mcp-jq-filter']) return;
        const key = `${method.toUpperCase()} ${path}`;
        if (explicitProp) {
          op['x-mcp-jq-filter'] = `.${explicitProp}`;
          unwrapped.push(key);
        } else {
          // Boolean `true`: only unwrap when the success schema actually has a
          // `data` envelope, so non-enveloped responses are left untouched.
          const schema = successSchema(op);
          if (schema && hasProperty(schema, 'data')) {
            op['x-mcp-jq-filter'] = '.data';
            unwrapped.push(key);
          }
        }
      });
    }
  }

  // 3. Named environments → base URL + MCP_ENVIRONMENTS seed.
  let environments: Record<string, string> | undefined;
  let defaultEnvironment: string | undefined;
  let baseUrl: string | undefined;
  if (config.environments && typeof config.environments === 'object') {
    const entries = (
      Object.entries(config.environments).filter(([, v]) => typeof v === 'string' && v) as [
        string,
        string,
      ][]
    ).filter(([name]) => {
      // The name is emitted as `API_ENVIRONMENT=<name>` (and as a JSON key in
      // MCP_ENVIRONMENTS) into the .env.example users copy to .env. Reject any
      // name outside a conservative token grammar so a name with a newline or
      // shell metacharacters cannot inject extra dotenv lines (config injection).
      if (isSafeEnvironmentName(name)) return true;
      warnings.push(`Ignoring environment "${name}" — name is not a safe token ([A-Za-z0-9_.-]).`);
      return false;
    });
    if (entries.length > 0) {
      environments = Object.fromEntries(entries);
      defaultEnvironment = 'production' in environments ? 'production' : entries[0][0];
      baseUrl = environments[defaultEnvironment];
      report.push(
        `Environments: ${entries.map(([n]) => n).join(', ')} (default "${defaultEnvironment}" → ${baseUrl}).`,
      );
    }
  }

  // 4. Auth: pick a security scheme and/or rename its env var (read_env).
  const authOverride = deriveAuthOverride(config);
  if (authOverride) {
    if (authOverride.schemeName) {
      report.push(`Auth: pinned to security scheme "${authOverride.schemeName}".`);
    }
    if (authOverride.envVarName) {
      report.push(`Auth: credential read from env var "${authOverride.envVarName}" (read_env).`);
    }
  }

  // 5. Code-mode detection (Stainless's current 2-tool default).
  const mcp = resolveMcpServer(config);
  const codeMode = !!(
    mcp &&
    (mcp.code === true ||
      mcp.code_execution === true ||
      mcp.tools === 'code' ||
      (Array.isArray(mcp.tools) && mcp.tools.includes('code')))
  );
  const docsSearch = !!(mcp && mcp.docs_search === true);
  if (codeMode) {
    warnings.push(
      'Stainless code-mode MCP server detected (a sandboxed code-execution tool + docs-search). ' +
        'mcpmake has no sandbox/code-exec equivalent — generating OWNED, editable per-endpoint ' +
        'tools instead. For large APIs add --dynamic-discovery (search_tools + on-demand schemas) ' +
        'as the token-efficiency analog.',
    );
  }

  if (Object.keys(toolNames).length > 0) {
    report.push(
      `Tool names: derived ${Object.keys(toolNames).length} name(s) from the resource tree.`,
    );
  }
  if (unwrapped.length > 0) {
    report.push(`Response unwrap: applied a jq filter to ${unwrapped.length} operation(s).`);
  }
  if (skipped.length > 0) {
    report.push(`Excluded ${skipped.length} operation(s) marked non-MCP in the Stainless config.`);
  }

  return {
    toolNames,
    environments,
    defaultEnvironment,
    baseUrl,
    authOverride,
    unwrapped,
    skipped,
    codeMode,
    docsSearch,
    warnings,
    report,
  };
}

// ---------------------------------------------------------------------------
// Resource tree
// ---------------------------------------------------------------------------

function walkResources(
  resources: Record<string, StainlessResource>,
  chain: string[],
  visit: (methodName: string, value: StainlessMethodValue, chain: string[]) => void,
): void {
  for (const [resourceName, resource] of Object.entries(resources)) {
    if (!resource || typeof resource !== 'object') continue;
    const here = [...chain, resourceName];
    if (resource.methods && typeof resource.methods === 'object') {
      for (const [methodName, value] of Object.entries(resource.methods)) {
        visit(methodName, value, here);
      }
    }
    if (resource.subresources && typeof resource.subresources === 'object') {
      walkResources(resource.subresources, here, visit);
    }
  }
}

interface MethodPointer {
  method?: string;
  path?: string;
  operationId?: string;
}

function parseMethodPointer(value: StainlessMethodValue): MethodPointer {
  if (typeof value === 'string') {
    const parts = value.trim().split(/\s+/);
    if (parts.length >= 2 && HTTP_METHODS.has(parts[0].toLowerCase())) {
      return { method: parts[0].toLowerCase(), path: parts.slice(1).join(' ') };
    }
    return { operationId: value.trim() };
  }
  if (value && typeof value === 'object') {
    if (typeof value.endpoint === 'string') {
      const parts = value.endpoint.trim().split(/\s+/);
      if (parts.length >= 2 && HTTP_METHODS.has(parts[0].toLowerCase())) {
        return { method: parts[0].toLowerCase(), path: parts.slice(1).join(' ') };
      }
    }
    return {
      method: typeof value.method === 'string' ? value.method.toLowerCase() : undefined,
      path: typeof value.path === 'string' ? value.path : undefined,
      operationId:
        (typeof value.operationId === 'string' && value.operationId) ||
        (typeof value.operation_id === 'string' && value.operation_id) ||
        undefined,
    };
  }
  return {};
}

function locateOperation(api: OpenAPIV3.Document, ptr: MethodPointer): AnyOperation | undefined {
  if (ptr.method && ptr.path) {
    const op = getOperation(api, ptr.method, ptr.path);
    if (op) return op;
  }
  if (ptr.operationId) {
    return getOperationById(api, ptr.operationId);
  }
  return undefined;
}

function getOperation(
  api: OpenAPIV3.Document,
  method: string,
  path: string,
): AnyOperation | undefined {
  const pathItem = (api.paths as Record<string, unknown> | undefined)?.[path];
  if (!pathItem || typeof pathItem !== 'object') return undefined;
  const op = (pathItem as Record<string, unknown>)[method];
  return op && typeof op === 'object' ? (op as AnyOperation) : undefined;
}

function getOperationById(api: OpenAPIV3.Document, operationId: string): AnyOperation | undefined {
  let found: AnyOperation | undefined;
  forEachOperation(api, (op) => {
    if (!found && op.operationId === operationId) found = op;
  });
  return found;
}

function forEachOperation(
  api: OpenAPIV3.Document,
  visit: (op: AnyOperation, method: string, path: string) => void,
): void {
  for (const [path, pathItem] of Object.entries(
    (api.paths as Record<string, unknown> | undefined) ?? {},
  )) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method];
      if (op && typeof op === 'object') visit(op as AnyOperation, method, path);
    }
  }
}

function opKey(op: AnyOperation): string {
  const id = typeof op.operationId === 'string' ? op.operationId : 'op';
  return id;
}

function isMethodSkipped(value: StainlessMethodValue): boolean {
  if (value && typeof value === 'object') {
    if (value.skip === true) return true;
    if (value.mcp === false) return true;
    if (value.mcp && typeof value.mcp === 'object' && value.mcp.enabled === false) return true;
  }
  return false;
}

function isStainlessSkipped(op: AnyOperation): boolean {
  if (op['x-stainless-skip'] === true) return true;
  if (op['x-stainless-mcp'] === false) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Reproduce Stainless's resource-tree tool naming: the SDK call
 * `<resource>.<method>` becomes the tool `<method>_<singular resource chain>`,
 * child-first — e.g. `cards.issuing.create` → `create_issuing_card`.
 */
export function toolNameFromTree(methodName: string, chain: string[]): string {
  const method = methodName === 'del' ? 'delete' : methodName;
  const tail = chain.slice().reverse().map(singularize).map(toSnake).filter(Boolean);
  const head = toSnake(method);
  return [head, ...tail].filter(Boolean).join('_');
}

export function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/(ss|us|is)$/i.test(word)) return word; // status, focus, analysis — leave alone
  if (/(s|x|z|ch|sh)es$/i.test(word)) return word.replace(/es$/i, '');
  if (/s$/i.test(word)) return word.replace(/s$/i, '');
  return word;
}

function toSnake(word: string): string {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s./-]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Responses / auth / mcp
// ---------------------------------------------------------------------------

function successSchema(op: AnyOperation): Record<string, unknown> | undefined {
  const responses = op.responses as Record<string, unknown> | undefined;
  if (!responses) return undefined;
  const response = (responses['200'] ?? responses['201']) as Record<string, unknown> | undefined;
  const content = response?.content as Record<string, unknown> | undefined;
  const media = content?.['application/json'] as Record<string, unknown> | undefined;
  const schema = media?.schema;
  return schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : undefined;
}

function hasProperty(schema: Record<string, unknown>, prop: string): boolean {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (props && typeof props === 'object' && prop in props) return true;
  // Dereferenced specs (e.g. Stripe-style list envelopes) often compose the
  // envelope as `allOf`/`oneOf`/`anyOf` rather than a flat `properties`.
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const members = schema[key];
    if (
      Array.isArray(members) &&
      members.some(
        (m) => m && typeof m === 'object' && hasProperty(m as Record<string, unknown>, prop),
      )
    ) {
      return true;
    }
  }
  return false;
}

function deriveAuthOverride(config: StainlessConfig): AuthOverride | undefined {
  const opts = config.client_settings?.opts;
  if (!opts || typeof opts !== 'object') return undefined;
  for (const opt of Object.values(opts)) {
    if (!opt || typeof opt !== 'object') continue;
    const schemeName =
      opt.auth && typeof opt.auth === 'object' && typeof opt.auth.security_scheme === 'string'
        ? opt.auth.security_scheme
        : undefined;
    const envVarName =
      typeof opt.read_env === 'string' ? sanitizeEnvVarName(opt.read_env) : undefined;
    if (schemeName || envVarName) return { schemeName, envVarName };
  }
  return undefined;
}

/**
 * Coerce a Stainless `read_env` value into a valid POSIX-style env-var name so
 * it is safe to emit as `process.env.<name>` / `os.environ.get("<name>")` in the
 * generated code. (Real read_env values already look like `ACME_API_KEY`; this
 * just guarantees an odd one can't produce invalid source.) Returns undefined
 * when nothing usable remains.
 */
export function sanitizeEnvVarName(raw: string): string | undefined {
  let name = raw.trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (name && /^[0-9]/.test(name)) name = `_${name}`;
  return name.length > 0 ? name : undefined;
}

/**
 * A Stainless environment name is safe to emit into `.env.example` only when it
 * matches a conservative token grammar — no whitespace (incl. newlines that
 * would inject extra dotenv lines), quotes, or shell/dotenv metacharacters.
 */
export function isSafeEnvironmentName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name);
}

function resolveMcpServer(config: StainlessConfig): Record<string, unknown> | undefined {
  if (config.mcp_server && typeof config.mcp_server === 'object') {
    return config.mcp_server as Record<string, unknown>;
  }
  const targets = config.targets;
  if (targets && typeof targets === 'object') {
    const candidate =
      (targets as Record<string, unknown>).mcp_server ?? (targets as Record<string, unknown>).mcp;
    if (candidate && typeof candidate === 'object') return candidate as Record<string, unknown>;
  }
  return undefined;
}
