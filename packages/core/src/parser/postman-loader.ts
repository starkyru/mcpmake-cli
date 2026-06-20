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

  // Resolve variables
  const vars = new Map<string, string>();
  for (const v of collection.variable ?? []) {
    vars.set(v.key, v.value);
  }

  const entries: Entry[] = [];
  flattenItems(collection.item, entries, vars);

  return { entries, collectionName: collection.info.name };
}

function flattenItems(items: PostmanItem[], entries: Entry[], vars: Map<string, string>): void {
  for (const item of items) {
    if (item.item) {
      flattenItems(item.item, entries, vars);
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
  const headers = (req.header ?? []).map((h) => ({
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
  const host = url.host?.join('.') ?? 'localhost';
  const path = url.path?.join('/') ?? '';
  const base = `${protocol}://${host}/${path}`;

  const parsed = new URL(resolveVars(base, vars));
  for (const q of url.query ?? []) {
    parsed.searchParams.set(q.key, resolveVars(q.value, vars));
  }

  return parsed.toString();
}

function resolveVars(str: string, vars: Map<string, string>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars.get(key) ?? `{{${key}}}`);
}
