/**
 * Plugin loader — discovers and loads McpmakeAdapter implementations.
 *
 * Plugins are loaded from:
 * 1. Built-in adapters (openapi, har, url, describe)
 * 2. npm packages named `mcpmake-adapter-*`
 * 3. Local files specified via --adapter flag
 */

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

/**
 * Load an adapter from a file path or npm package name.
 */
export async function loadAdapterFromPath(pathOrPackage: string): Promise<McpmakeAdapter> {
  let module: { default?: McpmakeAdapter };

  try {
    if (pathOrPackage.startsWith('.') || pathOrPackage.startsWith('/')) {
      // Local file
      const url = pathToFileURL(pathOrPackage).href;
      module = await import(url);
    } else {
      // npm package
      module = await import(pathOrPackage);
    }
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
