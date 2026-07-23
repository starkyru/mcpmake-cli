import type { AuthScheme, JsonSchema, OperationDescriptor } from '../types/index.js';
import { checkResponseShape, type ShapeDivergence } from './shape-check.js';
import { deriveParamSample } from './sample-values.js';

const READONLY_METHODS = new Set(['get', 'head']);
const DEFAULT_TIMEOUT_MS = 15_000;

export type OperationCheckStatus = 'ok' | 'drift' | 'skipped' | 'error';

export interface OperationCheckResult {
  operationId: string;
  method: string;
  path: string;
  status: OperationCheckStatus;
  httpStatus?: number;
  divergences?: ShapeDivergence[];
  /** Human-readable reason for skip/error/no-op (never contains secrets). */
  reason?: string;
}

export interface VerifyLiveReport {
  results: OperationCheckResult[];
  counts: { ok: number; drift: number; skipped: number; error: number };
  /** True when any operation drifted or errored — callers should exit non-zero. */
  failed: boolean;
}

export interface VerifyLiveOptions {
  /** Base URL of the live API (spec `servers[0].url` or an override). */
  baseUrl: string;
  /** Credential source — pass `process.env`. Values are read, never logged. */
  env?: Record<string, string | undefined>;
  /** Detected auth schemes (from `detectAuthSchemes`). */
  authSchemes?: AuthScheme[];
  /**
   * Replay write operations (POST/PUT/PATCH/DELETE) too. OFF by default: a live
   * verify must never mutate the target API without an explicit opt-in.
   */
  includeWrites?: boolean;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Replay each operation against the live API and compare the real response to
 * the operation's declared OpenAPI response schema — surfacing *live drift* the
 * static `verify` (spec-vs-generated-files) cannot see: a spec that still parses
 * and regenerates cleanly while the real API silently stopped honoring it.
 *
 * Safe by default: only read-only methods (GET/HEAD) are replayed unless
 * `includeWrites` is set, and operations whose required parameters have no
 * spec-provided example are skipped (never called with a fabricated argument).
 */
export async function verifyLive(
  operations: OperationDescriptor[],
  options: VerifyLiveOptions,
): Promise<VerifyLiveReport> {
  const env = options.env ?? {};
  const authSchemes = options.authSchemes ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const includeWrites = options.includeWrites ?? false;
  const doFetch = options.fetchImpl ?? fetch;

  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new Error(`Invalid base URL: ${options.baseUrl}`);
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`Base URL must be http(s): ${options.baseUrl}`);
  }

  const results: OperationCheckResult[] = [];
  for (const op of operations) {
    results.push(await checkOne(op, { base, env, authSchemes, includeWrites, timeoutMs, doFetch }));
  }

  const counts = { ok: 0, drift: 0, skipped: 0, error: 0 };
  for (const r of results) counts[r.status]++;
  return { results, counts, failed: counts.drift + counts.error > 0 };
}

interface CheckCtx {
  base: URL;
  env: Record<string, string | undefined>;
  authSchemes: AuthScheme[];
  includeWrites: boolean;
  timeoutMs: number;
  doFetch: typeof fetch;
}

async function checkOne(op: OperationDescriptor, ctx: CheckCtx): Promise<OperationCheckResult> {
  const method = op.method.toLowerCase();
  const rec = (
    status: OperationCheckStatus,
    extra?: Partial<OperationCheckResult>,
  ): OperationCheckResult => ({
    operationId: op.operationId,
    method: op.method.toUpperCase(),
    path: op.path,
    status,
    ...extra,
  });

  if (!READONLY_METHODS.has(method) && !ctx.includeWrites) {
    return rec('skipped', { reason: 'write method (use --include-writes to replay)' });
  }

  // Resolve path parameters from spec examples only.
  let pathname = op.path;
  for (const pp of op.parameters.filter((p) => p.in === 'path')) {
    const sample = deriveParamSample(pp.schema);
    if (sample === undefined) {
      return rec('skipped', { reason: `no example for required path param "${pp.name}"` });
    }
    pathname = pathname.replace(`{${pp.name}}`, encodeURIComponent(String(sample)));
  }
  if (/\{[^}]+\}/.test(pathname)) {
    return rec('skipped', { reason: 'unresolved path template' });
  }

  const url = new URL(ctx.base.toString());
  url.pathname = joinPath(ctx.base.pathname, pathname);

  // Required query params (optional ones omitted to keep the probe minimal).
  for (const qp of op.parameters.filter((p) => p.in === 'query' && p.required)) {
    const sample = deriveParamSample(qp.schema);
    if (sample === undefined) {
      return rec('skipped', { reason: `no example for required query param "${qp.name}"` });
    }
    url.searchParams.set(qp.name, String(sample));
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  for (const hp of op.parameters.filter((p) => p.in === 'header' && p.required)) {
    const sample = deriveParamSample(hp.schema);
    if (sample === undefined) {
      return rec('skipped', { reason: `no example for required header "${hp.name}"` });
    }
    headers[hp.name] = String(sample);
  }

  // Apply auth unless the operation is explicitly public (`security: []`).
  if (op.securityOptional !== true) applyAuth(headers, url, ctx.authSchemes, ctx.env);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  let res: Response;
  try {
    res = await ctx.doFetch(url.toString(), {
      method: method.toUpperCase(),
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    return rec('error', { reason: classifyFetchError(err) });
  } finally {
    clearTimeout(timer);
  }

  const httpStatus = res.status;
  // A non-2xx is not schema drift — it usually means a stale sample id, missing
  // credentials, or a server-side fault. Report it as an error so it is visible
  // without falsely claiming the response shape drifted.
  if (httpStatus < 200 || httpStatus >= 300) {
    return rec('error', { httpStatus, reason: `HTTP ${httpStatus}` });
  }
  if (method === 'head') return rec('ok', { httpStatus });

  const schema = selectResponseSchema(op, httpStatus);
  if (!schema) return rec('ok', { httpStatus, reason: 'no response schema to validate' });

  let text: string;
  try {
    text = await res.text();
  } catch {
    return rec('error', { httpStatus, reason: 'failed to read response body' });
  }
  if (text.trim() === '') {
    return rec('drift', {
      httpStatus,
      divergences: [{ path: '$', kind: 'not-json', expected: 'JSON body', actual: 'empty body' }],
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rec('drift', {
      httpStatus,
      divergences: [{ path: '$', kind: 'not-json', expected: 'JSON', actual: 'non-JSON body' }],
    });
  }

  const divergences = checkResponseShape(body, schema);
  if (divergences.length > 0) return rec('drift', { httpStatus, divergences });
  return rec('ok', { httpStatus });
}

/**
 * Pick the response schema to validate against: the exact status, then the
 * status class (`2XX`), then `200`, then `default`. Returns undefined when the
 * operation declares no schema for any of these (nothing to assert).
 */
function selectResponseSchema(op: OperationDescriptor, status: number): JsonSchema | undefined {
  const byCode = (code: string): JsonSchema | undefined =>
    op.responses.find((r) => r.statusCode === code)?.schema;
  const cls = `${Math.floor(status / 100)}XX`;
  return (
    byCode(String(status)) ??
    byCode(cls) ??
    byCode(cls.toLowerCase()) ??
    byCode('200') ??
    byCode('default')
  );
}

function joinPath(basePath: string, opPath: string): string {
  const a = basePath.replace(/\/+$/, '');
  const b = opPath.startsWith('/') ? opPath : `/${opPath}`;
  return `${a}${b}` || '/';
}

function appendCookie(existing: string | undefined, name: string, value: string): string {
  const pair = `${name}=${value}`;
  return existing ? `${existing}; ${pair}` : pair;
}

/**
 * Apply configured auth to the outgoing request, mirroring the generated
 * server's auth-provider. Credentials are read from `env` and never logged.
 * A scheme whose credential is absent is silently skipped (the call may 401 →
 * reported as an error, which is the honest signal).
 */
function applyAuth(
  headers: Record<string, string>,
  url: URL,
  authSchemes: AuthScheme[],
  env: Record<string, string | undefined>,
): void {
  for (const s of authSchemes) {
    if (s.type === 'apiKey') {
      const v = env[s.envVarName];
      if (!v || !s.headerName) continue;
      if (s.in === 'query') url.searchParams.set(s.headerName, v);
      else if (s.in === 'cookie')
        headers['cookie'] = appendCookie(headers['cookie'], s.headerName, v);
      else headers[s.headerName] = v;
    } else if (s.type === 'http-bearer') {
      const v = env[s.envVarName];
      if (v) headers['authorization'] = `Bearer ${v}`;
    } else if (s.type === 'http-basic') {
      const u = env['BASIC_USERNAME'];
      const pw = env['BASIC_PASSWORD'];
      if (u && pw)
        headers['authorization'] = `Basic ${Buffer.from(`${u}:${pw}`).toString('base64')}`;
    } else if (s.type === 'oauth2') {
      const v = env['OAUTH2_TOKEN'];
      if (v) headers['authorization'] = `Bearer ${v}`;
    }
  }
}

function classifyFetchError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'request timed out';
  return 'network error';
}
