/**
 * Plugin loader — discovers and loads McpmakeAdapter implementations.
 *
 * Plugins are loaded from:
 * 1. Built-in adapters (openapi, har, url, describe)
 * 2. npm packages named `mcpmake-adapter-*`
 * 3. Local files specified via --adapter flag
 */

import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpmakeAdapter } from './adapter.js';
import { logger } from '../utils/logger.js';

const registry = new Map<string, McpmakeAdapter>();

/**
 * Register a plugin adapter.
 */
export function registerAdapter(adapter: McpmakeAdapter): void {
  if (registry.has(adapter.name)) {
    logger.warn(`Adapter "${adapter.name}" already registered, overwriting`);
  }
  registry.set(adapter.name, adapter);
}

/**
 * Get a registered adapter by name.
 */
export function getAdapter(name: string): McpmakeAdapter | undefined {
  return registry.get(name);
}

/**
 * List all registered adapters.
 */
export function listAdapters(): McpmakeAdapter[] {
  return [...registry.values()];
}

/** Bare npm package: `pkg`, `@scope/pkg`, optional subpath (`pkg/sub`). */
const BARE_PACKAGE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[^\s]+)?$/i;

/**
 * Resolve + validate a plugin specifier into something safe to `import()`.
 *
 * Trust boundary: the specifier is operator-configured (a `--adapter` flag or a
 * trusted config), NOT end-user input — so this is hardening, not a full
 * sandbox. We accept only (a) bare npm package names (optionally scoped) and
 * (b) local paths that resolve *inside* `pluginsDir` when one is supplied.
 * Path-traversal and absolute paths that escape the allowed dir are rejected so
 * a stray/typo'd config cannot turn into an arbitrary-file `import()`.
 */
function resolveSpecifier(pathOrPackage: string, pluginsDir?: string): string {
  const isPathLike =
    pathOrPackage.startsWith('.') || pathOrPackage.startsWith('/') || isAbsolute(pathOrPackage);

  if (!isPathLike) {
    if (!BARE_PACKAGE.test(pathOrPackage)) {
      throw new Error(`Invalid adapter specifier "${pathOrPackage}": not a valid npm package name`);
    }
    return pathOrPackage; // resolved by the Node module resolver
  }

  if (!pluginsDir) {
    throw new Error(
      `Refusing to load adapter from path "${pathOrPackage}": no plugins directory is configured`,
    );
  }

  const base = resolve(pluginsDir);
  const target = resolve(base, pathOrPackage);
  const rel = relative(base, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Refusing to load adapter "${pathOrPackage}": resolves outside the plugins directory`,
    );
  }
  return pathToFileURL(target).href;
}

/**
 * Load an adapter from a file path or npm package name.
 *
 * `pluginsDir` is the operator-configured directory that local-path adapters
 * must live under; bare npm package names load regardless. See
 * `resolveSpecifier` for the trust boundary.
 */
export async function loadAdapterFromPath(
  pathOrPackage: string,
  pluginsDir?: string,
): Promise<McpmakeAdapter> {
  let module: { default?: McpmakeAdapter };

  const specifier = resolveSpecifier(pathOrPackage, pluginsDir);
  try {
    module = await import(specifier);
  } catch (err) {
    throw new Error(
      `Failed to load adapter from "${pathOrPackage}": ${err instanceof Error ? err.message : err}`,
    );
  }

  const adapter = module.default;
  if (!adapter || typeof adapter.name !== 'string' || typeof adapter.parse !== 'function') {
    throw new Error(
      `Invalid adapter: "${pathOrPackage}" must export a default McpmakeAdapter with name and parse()`,
    );
  }

  registerAdapter(adapter);
  return adapter;
}
