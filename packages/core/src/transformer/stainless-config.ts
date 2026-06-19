/**
 * Parsing + typing for a Stainless `stainless.yml` (openapi-stainless) config.
 *
 * Stainless was acquired by Anthropic (~May 2026) and its hosted MCP generator
 * is winding down. This module reads the build config a Stainless user already
 * has so `mcpmake from stainless` can reproduce the equivalent — owned, editable
 * — MCP server. We only model the keys that affect the MCP tool surface or that
 * the importer translates; everything else is ignored (forward-compatible).
 */
import { resolve, dirname, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type StainlessMethodValue =
  | string
  | {
      endpoint?: string;
      operationId?: string;
      operation_id?: string;
      method?: string;
      path?: string;
      // Per-method MCP toggles (Stainless lets you drop a method from the MCP target).
      mcp?: boolean | { enabled?: boolean };
      skip?: boolean;
      paginated?: unknown;
      [k: string]: unknown;
    };

export interface StainlessResource {
  methods?: Record<string, StainlessMethodValue>;
  subresources?: Record<string, StainlessResource>;
  models?: Record<string, string>;
  [k: string]: unknown;
}

export interface StainlessOpt {
  type?: string;
  /** Custom env-var name the SDK/MCP reads the secret from (e.g. `ACME_API_KEY`). */
  read_env?: string;
  auth?: {
    security_scheme?: string;
    role?: string;
  };
  [k: string]: unknown;
}

export interface StainlessMcpServer {
  /** Stainless's current default: a 2-tool code-execution + docs-search server. */
  code?: boolean;
  code_execution?: boolean;
  tools?: string | string[];
  docs_search?: boolean;
  [k: string]: unknown;
}

export interface StainlessConfig {
  'config-version'?: number;
  organization?: string;
  /** Path to the referenced OpenAPI document. */
  openapi?: string | { path?: string; spec?: string };
  spec?: string;
  /** Named base URLs: { production: "https://...", sandbox: "https://..." }. */
  environments?: Record<string, string>;
  client_settings?: {
    opts?: Record<string, StainlessOpt>;
    [k: string]: unknown;
  };
  security?: unknown;
  resources?: Record<string, StainlessResource>;
  settings?: {
    /** Auto-unwrap a nested response envelope. `true` => `data`, or a prop name. */
    unwrap_response?: boolean | string;
    [k: string]: unknown;
  };
  targets?: Record<string, unknown>;
  mcp_server?: StainlessMcpServer;
  [k: string]: unknown;
}

/**
 * Parse a `stainless.yml` (YAML, with a JSON fallback). Throws a clear error on
 * malformed input or a non-object document.
 */
export function parseStainlessConfig(raw: string): StainlessConfig {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    // `yaml` accepts JSON too, but fall back explicitly for robustness.
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Could not parse Stainless config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Stainless config must be a YAML/JSON object.');
  }
  return doc as StainlessConfig;
}

/**
 * Resolve the OpenAPI spec the Stainless config points at, relative to the
 * config file's directory. An explicit `override` (the CLI `--spec` flag) wins.
 * Returns `undefined` when neither the config nor the override names a spec.
 */
export function resolveSpecPath(
  config: StainlessConfig,
  configPath: string,
  override?: string,
): string | undefined {
  if (override) return override;

  let ref: string | undefined;
  if (typeof config.openapi === 'string') {
    ref = config.openapi;
  } else if (config.openapi && typeof config.openapi === 'object') {
    ref = config.openapi.path ?? config.openapi.spec;
  }
  ref = ref ?? config.spec;
  if (!ref) return undefined;

  // Leave URLs and absolute paths untouched; resolve relative paths against the
  // config file's directory (the conventional Stainless layout).
  if (/^https?:\/\//i.test(ref) || isAbsolute(ref)) return ref;
  return resolve(dirname(configPath), ref);
}
