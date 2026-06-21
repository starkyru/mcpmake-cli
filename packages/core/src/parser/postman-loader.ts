/**
 * Postman Collection v2.1 to HAR Entry converter.
 * Converts Postman items into HAR entries that feed into the existing HAR pipeline.
 */

import { readFile, stat } from 'node:fs/promises';
import type { Entry } from 'har-format';

const MAX_COLLECTION_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB — bound untrusted input (DoS-lite)

interface PostmanCollection {
  info: { name: string; schema: string };
  item: PostmanItem[];
  variable?: Array<{ key: string; value: string }>;
}

interface PostmanItem {
  name: string;
  request?: PostmanRequest;
  item?: PostmanItem[]; // folders
}

interface PostmanRequest {
  method: string;
  header?: Array<{ key: string; value: string }>;
  url: PostmanUrl | string;
  body?: { mode: string; raw?: string; formdata?: Array<{ key: string; value: string }> };
  auth?: { type: string };
}

interface PostmanUrl {
  raw?: string;
  protocol?: string;
  host?: string[];
  path?: string[];
  query?: Array<{ key: string; value: string }>;
}

export async function loadPostmanCollection(filePath: string): Promise<{
  entries: Entry[];
  collectionName: string;
}> {
  const fileInfo = await stat(filePath);
  if (fileInfo.size > MAX_COLLECTION_SIZE_BYTES) {
    throw new Error(
      `Postman collection is too large (${Math.round(fileInfo.size / 1024 / 1024)} MB). Maximum is 50 MB.`,
    );
  }

  const raw = await readFile(filePath, 'utf-8');
  const collection: PostmanCollection = JSON.parse(raw);

  if (!collection.info || !collection.item) {
    throw new Error('Invalid Postman collection: missing info or item fields');
  }
  if (!Array.isArray(collection.item)) {
    return { entries: [], collectionName: collection.info.name };
  }

  // Resolve variables
  const vars = new Map<string, string>();
  for (const v of collection.variable ?? []) {
    // R23-B: null/non-object elements in the variable array must be skipped.
    if (v === null || typeof v !== 'object') continue;
    if (typeof v.key !== 'string' || typeof v.value !== 'string') continue;
    vars.set(v.key, v.value);
  }

  const entries: Entry[] = [];
  flattenItems(collection.item, entries, vars);

  return { entries, collectionName: collection.info.name };
}

function flattenItems(
  items: PostmanItem[],
  entries: Entry[],
  vars: Map<string, string>,
  depth = 0,
): void {
  // R22-3: a non-array `item` (e.g. `item: {}`) passes the truthy check in the
  // caller but is not iterable. Treat it as an empty folder rather than crashing.
  if (!Array.isArray(items)) return;

  // A4-3: cap folder nesting to prevent stack-overflow DoS from adversarially
  // crafted deeply nested Postman collections.
  if (depth > 100) {
    throw new Error('Postman collection nesting too deep (> 100 levels)');
  }

  for (const item of items) {
    // R23-B: null/non-object elements (e.g. `"item": [null]`) must be skipped
    // rather than crashing on property access.
    if (item === null || typeof item !== 'object') continue;
    if (item.item) {
      flattenItems(item.item, entries, vars, depth + 1);
    }
    if (item.request) {
      const entry = convertToHarEntry(item, vars);
      if (entry) entries.push(entry);
    }
  }
}

function convertToHarEntry(item: PostmanItem, vars: Map<string, string>): Entry | null {
  const req = item.request!;
  const url = resolveUrl(req.url, vars);
  if (!url) return null;

  const method = req.method ?? 'GET';
  // R23-B: filter null/non-object elements before mapping to avoid null.key crashes.
  const headers = (req.header ?? [])
    .filter(
      (h): h is NonNullable<typeof h> =>
        h !== null &&
        typeof h === 'object' &&
        typeof h.key === 'string' &&
        typeof h.value === 'string',
    )
    .map((h) => ({
      name: h.key,
      value: resolveVars(h.value, vars),
    }));

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  const queryString = [...parsedUrl.searchParams.entries()].map(([name, value]) => ({
    name,
    value,
  }));

  const postData = req.body?.raw
    ? {
        mimeType:
          headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? 'application/json',
        text: resolveVars(req.body.raw, vars),
      }
    : undefined;

  return {
    startedDateTime: new Date().toISOString(),
    time: 0,
    request: {
      method: method.toUpperCase(),
      url,
      httpVersion: 'HTTP/1.1',
      headers,
      queryString,
      cookies: [],
      headersSize: -1,
      bodySize: postData?.text ? Buffer.byteLength(postData.text) : 0,
      ...(postData ? { postData } : {}),
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'content-type', value: 'application/json' }],
      cookies: [],
      content: { size: 0, mimeType: 'application/json' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  };
}

function resolveUrl(url: PostmanUrl | string, vars: Map<string, string>): string | null {
  if (typeof url === 'string') return resolveVars(url, vars);

  if (url.raw) return resolveVars(url.raw, vars);

  const protocol = url.protocol ?? 'https';
  // R22-4a: `[].join('.')` yields `""` which is not nullish, so `?? 'localhost'`
  // would not fall back. Treat an empty/blank joined host as missing.
  const h = url.host?.join('.');
  const host = h && h.trim() ? h : 'localhost';
  const path = url.path?.join('/') ?? '';
  const base = `${protocol}://${host}/${path}`;

  // R22-4b: wrap in try/catch — a bad object url (invalid chars, etc.) returns
  // null so this entry is skipped, matching the string-branch behaviour above.
  let parsed: URL;
  try {
    parsed = new URL(resolveVars(base, vars));
  } catch {
    return null;
  }
  for (const q of url.query ?? []) {
    // R23-B: null/non-object query elements are skipped.
    if (q === null || typeof q !== 'object') continue;
    parsed.searchParams.set(q.key, resolveVars(q.value, vars));
  }

  return parsed.toString();
}

// Bound transitive resolution: a chain {{a}}->{{b}}->{{c}}... can need multiple
// passes, but the cap guarantees termination even when variable values form a
// cycle ({{a}}->{{b}}->{{a}}). On hitting the cap (or a no-op pass) we leave any
// still-unresolved tokens as-is rather than looping forever.
const MAX_VAR_RESOLUTION_PASSES = 10;

function resolveVars(str: string, vars: Map<string, string>): string {
  let current = str;
  for (let pass = 0; pass < MAX_VAR_RESOLUTION_PASSES; pass++) {
    // Single substitution pass. Unknown keys are preserved verbatim ({{key}});
    // because the replacement re-emits that exact token, a known->unknown chain
    // converges to a fixed point and the no-change check below stops the loop.
    const next = current.replace(/\{\{(\w+)\}\}/g, (_, key) => vars.get(key) ?? `{{${key}}}`);
    if (next === current) return next; // fixed point reached — fully resolved or only unknowns remain
    current = next;
  }
  // Cap reached (e.g. a {{a}}<->{{b}} cycle): return the last state, leaving the
  // remaining {{...}} tokens untouched so callers see them instead of hanging.
  return current;
}
