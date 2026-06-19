import type { OperationDescriptor } from '../types/index.js';
import { deriveResourceName } from './naming.js';

/**
 * Deterministic, offline tool naming from the REST resource tree (method+path),
 * the Stainless-style convention (`accounts.create` → `create_account`).
 *
 * Rewrites each operation's `operationId` to the derived resource name so the
 * rest of the pipeline (tool name/title/file/function + collision handling) all
 * flow from it. Unlike `improveToolNames` (LLM, needs an API key), this is free,
 * deterministic, and requires no network.
 *
 * Collision-safe: if a derived name is empty (no resource segment) or already
 * claimed by an earlier operation, the original `operationId` is kept so the
 * first claimant wins and no two operations get the same id here. Any remaining
 * cross-source duplicates are still handled downstream by `buildAllTools`.
 *
 * `x-mcp-name` per-tool overrides are applied later in `buildToolDefinition` and
 * always take precedence over this.
 */
export function resourceTreeNames(operations: OperationDescriptor[]): OperationDescriptor[] {
  const used = new Set<string>();
  return operations.map((op) => {
    const derived = deriveResourceName(op.method, op.path);
    if (!derived || used.has(derived)) {
      used.add(op.operationId);
      return op;
    }
    used.add(derived);
    return { ...op, operationId: derived };
  });
}
