import type { JsonSchema, OperationDescriptor } from '../types/index.js';
import { deriveParamSample } from './sample-values.js';

/** One generated functional smoke case: a read-only call + its shape assertion. */
export interface SmokeCase {
  /** Operation id — used as the test label. */
  name: string;
  /** HTTP method (GET or HEAD). */
  method: string;
  /** Path with all path params substituted from spec examples. */
  path: string;
  /** Required query params (name → sample), applied at request time. */
  query: Record<string, string>;
  /** Shape of the declared 2xx body, driving the runtime assertion. */
  bodyKind: 'object' | 'array' | 'other';
  /** Top-level required property names to assert present (object bodies). */
  requiredFields: string[];
}

/**
 * A detected list → item pair the generated suite can chain: fetch the list,
 * take the first element's id, then fetch that item — SmartBear-style "response
 * data chained across steps," but as test code the user owns.
 */
export interface SmokeChain {
  listName: string;
  listPath: string;
  itemName: string;
  /** Item path template, e.g. `/pets/{petId}`. */
  itemPathTemplate: string;
  /** The path-param name to fill from the list element. */
  idParam: string;
}

export interface SmokeSuite {
  cases: SmokeCase[];
  chain?: SmokeChain;
  skipped: { operationId: string; reason: string }[];
}

const READONLY = new Set(['get', 'head']);

function selectSuccessSchema(op: OperationDescriptor): JsonSchema | undefined {
  return (
    op.responses.find((r) => r.statusCode === '200')?.schema ??
    op.responses.find((r) => r.statusCode === '2XX' || r.statusCode === '2xx')?.schema ??
    op.responses.find((r) => /^2\d\d$/.test(r.statusCode))?.schema ??
    op.responses.find((r) => r.statusCode === 'default')?.schema
  );
}

function bodyShape(schema: JsonSchema | undefined): {
  bodyKind: SmokeCase['bodyKind'];
  requiredFields: string[];
} {
  if (!schema || typeof schema !== 'object') return { bodyKind: 'other', requiredFields: [] };
  const s = schema as Record<string, unknown>;
  const type = typeof s.type === 'string' ? s.type : Array.isArray(s.type) ? s.type[0] : undefined;
  if (type === 'array' || s.items !== undefined) return { bodyKind: 'array', requiredFields: [] };
  if (type === 'object' || s.properties !== undefined || s.required !== undefined) {
    const requiredFields = Array.isArray(s.required)
      ? (s.required as unknown[]).filter((k): k is string => typeof k === 'string')
      : [];
    return { bodyKind: 'object', requiredFields };
  }
  return { bodyKind: 'other', requiredFields: [] };
}

/** Try to resolve a read-only op into a smoke case; returns a skip reason instead. */
function toCase(op: OperationDescriptor): SmokeCase | { skip: string } {
  let path = op.path;
  for (const pp of op.parameters.filter((p) => p.in === 'path')) {
    const sample = deriveParamSample(pp.schema);
    if (sample === undefined) return { skip: `no example for path param "${pp.name}"` };
    path = path.replace(`{${pp.name}}`, encodeURIComponent(String(sample)));
  }
  if (/\{[^}]+\}/.test(path)) return { skip: 'unresolved path template' };

  const query: Record<string, string> = {};
  for (const qp of op.parameters.filter((p) => p.in === 'query' && p.required)) {
    const sample = deriveParamSample(qp.schema);
    if (sample === undefined) return { skip: `no example for required query param "${qp.name}"` };
    query[qp.name] = String(sample);
  }

  const { bodyKind, requiredFields } = bodyShape(selectSuccessSchema(op));
  return {
    name: op.operationId,
    method: op.method.toUpperCase(),
    path,
    query,
    bodyKind,
    requiredFields,
  };
}

/**
 * Detect the first clean list → item pair among GET operations: a
 * `GET /things/{id}` whose collection sibling `GET /things` returns an array.
 * The item path param can stay a template (its value comes from the list at
 * runtime), so a list→item pair is chainable even when `{id}` has no example.
 */
function detectChain(operations: OperationDescriptor[]): SmokeChain | undefined {
  const gets = operations.filter((op) => op.method.toLowerCase() === 'get');
  for (const item of gets) {
    const m = /^(.*)\/\{([^/{}]+)\}$/.exec(item.path);
    if (!m) continue;
    const [, prefix, idParam] = m;
    const list = gets.find((op) => op.path === prefix || op.path === `${prefix}/`);
    if (!list) continue;
    const { bodyKind } = bodyShape(selectSuccessSchema(list));
    if (bodyKind !== 'array') continue;
    // The list must itself be callable with no unresolved required params.
    const listCase = toCase(list);
    if ('skip' in listCase) continue;
    return {
      listName: list.operationId,
      listPath: listCase.path,
      itemName: item.operationId,
      itemPathTemplate: item.path,
      idParam,
    };
  }
  return undefined;
}

/**
 * Build the data model for a generated functional smoke suite from parsed
 * operations. Read-only operations with spec-provided examples become smoke
 * cases; the rest are recorded (with a reason) in `skipped`. Pure — does no I/O.
 */
export function buildSmokeSuite(operations: OperationDescriptor[]): SmokeSuite {
  const cases: SmokeCase[] = [];
  const skipped: { operationId: string; reason: string }[] = [];

  for (const op of operations) {
    const method = op.method.toLowerCase();
    if (!READONLY.has(method)) {
      skipped.push({ operationId: op.operationId, reason: 'write method (read-only suite)' });
      continue;
    }
    const built = toCase(op);
    if ('skip' in built) skipped.push({ operationId: op.operationId, reason: built.skip });
    else cases.push(built);
  }

  return { cases, chain: detectChain(operations), skipped };
}
