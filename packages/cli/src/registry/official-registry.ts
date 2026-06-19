/**
 * Official MCP Registry (registry.modelcontextprotocol.io) publishing support.
 *
 * Builds a `server.json` that conforms to the official server schema and the
 * metadata the `mcp-publisher` CLI uploads via `POST /v0/publish`. mcpmake does
 * not re-implement the registry's GitHub/DNS auth — it produces a correct
 * `server.json` (+ the npm `mcpName` validation marker) and hands off to
 * `mcp-publisher login` / `publish`.
 *
 * Schema + flow primary-verified against modelcontextprotocol.io/registry
 * (schema 2025-12-11) on 2026-06-18.
 */

/** Canonical server.json schema (pin the verified revision). */
export const OFFICIAL_SCHEMA_URL =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

/** Official registry host the `mcp-publisher` CLI publishes to. */
export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  format?: string;
}

export interface RegistryPackage {
  registryType: 'npm';
  identifier: string;
  version: string;
  transport: { type: 'stdio' };
  environmentVariables?: RegistryEnvVar[];
}

export interface RegistryRemote {
  type: 'streamable-http' | 'sse';
  url: string;
}

export interface ServerJson {
  $schema: string;
  name: string;
  description?: string;
  version: string;
  repository?: { url: string; source: string };
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

export interface BuildServerJsonInput {
  /** Reverse-DNS namespaced registry name, e.g. `io.github.user/weather`. */
  name: string;
  description?: string;
  version: string;
  repositoryUrl?: string;
  /** npm package name (from package.json `name`). */
  packageIdentifier: string;
  /** Published package version (usually equal to `version`). */
  packageVersion: string;
  environmentVariables?: RegistryEnvVar[];
  /** Optional hosted endpoint → emits a `remotes[]` entry. */
  remoteUrl?: string;
}

/**
 * Validate a registry server name. Must be `<reverse.dns.namespace>/<name>`
 * (the namespace carries at least one dot). Returns an error string, or null
 * when valid.
 */
export function validateServerName(name: string): string | null {
  if (!name.includes('/')) {
    return `Registry name must be "<namespace>/<name>" (e.g. io.github.you/my-server), got "${name}"`;
  }
  const [namespace, server, ...rest] = name.split('/');
  if (rest.length > 0) {
    return `Registry name must contain exactly one "/", got "${name}"`;
  }
  if (!namespace || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(namespace)) {
    return `Namespace "${namespace}" must be reverse-DNS (e.g. io.github.you)`;
  }
  if (!server || !/^[a-z0-9._-]+$/i.test(server)) {
    return `Server segment "${server}" may only contain letters, digits, ".", "_", "-"`;
  }
  return null;
}

/** Parse `owner`/`repo` out of a GitHub repository URL (https or ssh). */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[:/]+([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Determine the registry server name.
 * Priority: an explicit (already-namespaced) name → derived from the GitHub
 * repository URL as `io.github.<owner>/<repo>`. Returns null when undeterminable.
 */
export function deriveServerName(opts: {
  explicit?: string;
  repositoryUrl?: string;
}): string | null {
  if (opts.explicit) return opts.explicit;
  if (opts.repositoryUrl) {
    const gh = parseGitHubRepo(opts.repositoryUrl);
    if (gh) return `io.github.${gh.owner.toLowerCase()}/${gh.repo}`;
  }
  return null;
}

const SECRET_HINT = /(token|key|secret|password|passwd|credential|auth)/i;

/**
 * Parse a `.env.example` file into registry env-var specs. A comment line
 * immediately above a `VAR=` line becomes its description; names hinting at
 * credentials are flagged `isSecret`.
 */
export function parseEnvExample(content: string): RegistryEnvVar[] {
  const out: RegistryEnvVar[] = [];
  let pendingComment: string | undefined;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      pendingComment = undefined;
      continue;
    }
    if (line.startsWith('#')) {
      pendingComment = line.replace(/^#+\s*/, '').trim() || undefined;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      pendingComment = undefined;
      continue;
    }
    const name = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      pendingComment = undefined;
      continue;
    }
    out.push({
      name,
      description: pendingComment,
      isRequired: true,
      isSecret: SECRET_HINT.test(name),
      format: 'string',
    });
    pendingComment = undefined;
  }
  return out;
}

/** Build a schema-conformant server.json for the official registry. */
export function buildServerJson(input: BuildServerJsonInput): ServerJson {
  const pkg: RegistryPackage = {
    registryType: 'npm',
    identifier: input.packageIdentifier,
    version: input.packageVersion,
    transport: { type: 'stdio' },
  };
  if (input.environmentVariables && input.environmentVariables.length > 0) {
    pkg.environmentVariables = input.environmentVariables;
  }

  const server: ServerJson = {
    $schema: OFFICIAL_SCHEMA_URL,
    name: input.name,
    version: input.version,
    packages: [pkg],
  };
  if (input.description) server.description = input.description;
  if (input.repositoryUrl) {
    server.repository = { url: input.repositoryUrl, source: 'github' };
  }
  if (input.remoteUrl) {
    server.remotes = [{ type: 'streamable-http', url: input.remoteUrl }];
  }
  return server;
}
