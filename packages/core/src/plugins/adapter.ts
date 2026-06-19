/**
 * Plugin adapter interface for mcpmake.
 *
 * Third-party packages implement this interface to add new input formats.
 * Adapters convert their source format into OperationDescriptor[] —
 * the shared intermediate format that feeds into the tool builder and emitter.
 *
 * Example:
 *   export default class GraphQLAdapter implements McpmakeAdapter {
 *     name = 'graphql';
 *     description = 'Generate from GraphQL schema';
 *     async parse(input: string) { ... return operations; }
 *   }
 */

import type { OperationDescriptor, AuthScheme, EnvVarDescriptor } from '../types/index.js';

export interface AdapterResult {
  operations: OperationDescriptor[];
  baseUrl: string;
  authSchemes: AuthScheme[];
  envVars: EnvVarDescriptor[];
  info: {
    title: string;
    version: string;
    description?: string;
  };
}

export interface McpmakeAdapter {
  /** Unique adapter name (used as CLI subcommand: `mcpmake from <name>`) */
  name: string;

  /** Human-readable description */
  description: string;

  /** File extensions this adapter handles (e.g., ['.graphql', '.gql']) */
  extensions?: string[];

  /**
   * Parse the input source and return operations.
   * @param input — file path, URL, or other source identifier
   * @param options — adapter-specific options from CLI args
   */
  parse(input: string, options?: Record<string, unknown>): Promise<AdapterResult>;
}
