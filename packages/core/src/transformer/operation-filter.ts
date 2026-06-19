import type { OperationDescriptor } from '../types/index.js';

export interface FilterOptions {
  include?: string[];
  exclude?: string[];
}

/**
 * Filter operations by tag or path pattern.
 * Patterns can be:
 *   - A tag name: "pets" matches operations tagged with "pets"
 *   - A path prefix: "/users*" matches /users, /users/{id}, etc.
 *   - A glob-like pattern: "*admin*" matches any operation with "admin" in path or tags
 */
export function filterOperations(
  operations: OperationDescriptor[],
  options: FilterOptions,
): OperationDescriptor[] {
  let result = operations;

  if (options.include?.length) {
    result = result.filter((op) =>
      options.include!.some((pattern) => matchesOperation(op, pattern)),
    );
  }

  if (options.exclude?.length) {
    result = result.filter(
      (op) => !options.exclude!.some((pattern) => matchesOperation(op, pattern)),
    );
  }

  return result;
}

function matchesOperation(op: OperationDescriptor, pattern: string): boolean {
  const lowerPattern = pattern.toLowerCase();

  // Check tag match
  if (op.tags.some((t) => t.toLowerCase() === lowerPattern)) return true;

  // Check path match with simple glob support
  if (matchGlob(op.path.toLowerCase(), lowerPattern)) return true;

  // Check operationId match
  if (op.operationId.toLowerCase().includes(lowerPattern)) return true;

  return false;
}

function matchGlob(str: string, pattern: string): boolean {
  // Simple glob matching without regex to avoid ReDoS.
  // Split pattern by '*' and check that all parts appear in order.
  const parts = pattern.split('*');
  let pos = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '') continue;

    const idx = str.indexOf(part, pos);
    if (idx === -1) return false;

    // First segment must match at start, last at end
    if (i === 0 && idx !== 0) return false;
    pos = idx + part.length;
  }

  // If pattern doesn't end with *, the string must end at pos
  if (!pattern.endsWith('*') && pos !== str.length) return false;

  return true;
}
