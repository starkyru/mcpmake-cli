import type { Entry } from 'har-format';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_PATTERN = /^\d+$/;
const MONGO_ID_PATTERN = /^[0-9a-f]{24}$/i;
const SHORT_ID_PATTERN = /^[a-zA-Z0-9]{8,22}$/;

export interface NormalizedEntry {
  entry: Entry;
  normalizedPath: string;
  baseUrl: string;
  pathParams: PathParam[];
  queryParams: QueryParam[];
}

export interface PathParam {
  name: string;
  position: number;
  exampleValue: string;
  inferredType: 'uuid' | 'integer' | 'string';
}

export interface QueryParam {
  name: string;
  exampleValue: string;
  inferredType: 'integer' | 'boolean' | 'string';
}

export function normalizeEntry(entry: Entry): NormalizedEntry {
  const url = new URL(entry.request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const segments = url.pathname.split('/').filter(Boolean);
  const pathParams: PathParam[] = [];
  let paramCounter = 0;

  const normalizedSegments = segments.map((segment, i) => {
    if (UUID_PATTERN.test(segment)) {
      const name = deriveParamName(segments, i, paramCounter++);
      pathParams.push({ name, position: i, exampleValue: segment, inferredType: 'uuid' });
      return `{${name}}`;
    }
    if (NUMERIC_ID_PATTERN.test(segment) && segment.length < 15) {
      const name = deriveParamName(segments, i, paramCounter++);
      pathParams.push({ name, position: i, exampleValue: segment, inferredType: 'integer' });
      return `{${name}}`;
    }
    if (MONGO_ID_PATTERN.test(segment)) {
      const name = deriveParamName(segments, i, paramCounter++);
      pathParams.push({ name, position: i, exampleValue: segment, inferredType: 'string' });
      return `{${name}}`;
    }
    // Heuristic: if previous segment is a known collection name and this looks like an ID
    if (i > 0 && isCollectionName(segments[i - 1]) && SHORT_ID_PATTERN.test(segment)) {
      const prevSegment = segments[i - 1];
      // Only treat as ID if short enough and not a known sub-resource
      if (segment.length <= 22 && !isCollectionName(segment)) {
        const name = singularize(prevSegment) + 'Id';
        pathParams.push({ name, position: i, exampleValue: segment, inferredType: 'string' });
        return `{${name}}`;
      }
    }
    return segment;
  });

  const normalizedPath = '/' + normalizedSegments.join('/');

  const queryParams: QueryParam[] = [];
  for (const qs of entry.request.queryString ?? []) {
    if (
      qs === null ||
      typeof qs !== 'object' ||
      typeof qs.name !== 'string' ||
      typeof qs.value !== 'string'
    ) {
      continue;
    }
    queryParams.push({
      name: qs.name,
      exampleValue: qs.value,
      inferredType: inferQueryParamType(qs.value),
    });
  }

  return { entry, normalizedPath, baseUrl, pathParams, queryParams };
}

function deriveParamName(segments: string[], currentIndex: number, counter: number): string {
  if (currentIndex > 0) {
    const prev = segments[currentIndex - 1];
    if (isCollectionName(prev)) {
      return singularize(prev) + 'Id';
    }
  }
  return counter === 0 ? 'id' : `id${counter + 1}`;
}

// Version / routing prefixes that look plural-ish or otherwise sneak past the
// pattern but are never REST collections. `vN` is matched structurally below.
const NON_COLLECTION_SEGMENTS = new Set(['api', 'rest', 'graphql', 'rpc', 'status']);

function isCollectionName(segment: string): boolean {
  // Discriminating REST collection heuristic. The previous version returned true
  // for almost any segment (its second clause was `!['api','v1',...].includes(x)`,
  // i.e. true for everything except those four), which over-parameterized paths.
  //
  // A collection segment is a *plural resource name*: lowercase, alphanumeric
  // (allowing `_`/`-`), and ending in `s` but not `ss` (e.g. `users`, `posts`,
  // `items`, `api_keys` — but not `class`, `address`). We additionally exclude
  // version prefixes (`v1`, `v2`, …) and a small set of routing/non-resource
  // tokens, so a generic singular segment like `user`, `profile`, or a version
  // like `v1` is no longer treated as a collection.
  const s = segment.toLowerCase();
  if (NON_COLLECTION_SEGMENTS.has(s)) return false;
  if (/^v\d+$/.test(s)) return false; // version prefixes: v1, v2, v10, ...
  // Plural resource: starts with a letter, ends in `s`, but the char before the
  // trailing `s` is not itself `s` (excludes `class`, `address`, `status`).
  return /^[a-z][a-z0-9_-]*[^s]s$/.test(s);
}

function singularize(word: string): string {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes'))
    return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function inferQueryParamType(value: string): 'integer' | 'boolean' | 'string' {
  if (NUMERIC_ID_PATTERN.test(value)) return 'integer';
  if (value === 'true' || value === 'false') return 'boolean';
  return 'string';
}
