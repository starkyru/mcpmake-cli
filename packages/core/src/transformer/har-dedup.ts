import type { NormalizedEntry } from '../parser/har-normalizer.js';

/**
 * Deduplicate HAR entries that are likely pagination or retries.
 *
 * Strategy:
 * - Group by method + normalizedPath (same as clustering)
 * - Within each group, detect pagination patterns (same URL with different page/offset/cursor params)
 * - Remove retries: consecutive requests to the same URL within 5s with same method
 */
export function deduplicateEntries(entries: NormalizedEntry[]): NormalizedEntry[] {
  const result: NormalizedEntry[] = [];
  const seenSignatures = new Map<string, { lastTime: number; count: number }>();

  for (const entry of entries) {
    const url = entry.entry.request.url;
    const method = entry.entry.request.method;
    const signature = `${method} ${stripPaginationParams(url)}`;
    const timestamp = new Date(entry.entry.startedDateTime).getTime();

    const seen = seenSignatures.get(signature);

    if (seen) {
      // Skip retries: same signature within 5 seconds
      if (timestamp - seen.lastTime < 5000) {
        seen.lastTime = timestamp;
        seen.count++;
        continue;
      }

      // Skip excessive pagination: keep at most 3 examples per endpoint
      if (isPaginationVariant(url, entries, entry) && seen.count >= 3) {
        seen.lastTime = timestamp;
        seen.count++;
        continue;
      }
    }

    seenSignatures.set(signature, {
      lastTime: timestamp,
      count: (seen?.count ?? 0) + 1,
    });
    result.push(entry);
  }

  return result;
}

const PAGINATION_PARAMS = new Set([
  'page',
  'offset',
  'limit',
  'cursor',
  'after',
  'before',
  'skip',
  'take',
  'per_page',
  'page_size',
  'pagesize',
  'start',
  'count',
  'from',
  'next_token',
  'continuation',
]);

function stripPaginationParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (PAGINATION_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function isPaginationVariant(
  url: string,
  allEntries: NormalizedEntry[],
  current: NormalizedEntry,
): boolean {
  try {
    const parsed = new URL(url);
    const paramKeys = [...parsed.searchParams.keys()].map((k) => k.toLowerCase());
    return paramKeys.some((k) => PAGINATION_PARAMS.has(k));
  } catch {
    return false;
  }
}
