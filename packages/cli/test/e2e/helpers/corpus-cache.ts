/**
 * Download-on-demand cache for the real-world spec corpus.
 *
 * Specs are NOT vendored (13 MB of third-party files): each is fetched from a
 * commit-pinned raw URL into `node_modules/.cache/mcpmake-corpus/` and reused
 * across runs. Integrity is enforced with SHA-256:
 *
 * - a cached file with the right hash is used as-is (offline runs keep working
 *   once the cache is warm);
 * - a NETWORK failure returns null so the caller skips that spec cleanly
 *   (same convention as provision.ts);
 * - a HASH MISMATCH on a fresh download throws — the URL is commit-pinned, so
 *   different bytes mean a manifest typo or a tampered response, never a
 *   legitimate upstream change. That must fail loudly, not skip.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './build-guard.js';
import type { CorpusEntry } from '../corpus/manifest.js';

const CACHE_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'mcpmake-corpus');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export type CorpusFetchResult = { path: string } | { path: null; reason: string };

export async function fetchCorpusSpec(entry: CorpusEntry): Promise<CorpusFetchResult> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const target = join(CACHE_DIR, `${entry.name}.${entry.ext}`);

  if (existsSync(target) && sha256(readFileSync(target)) === entry.sha256) {
    return { path: target };
  }

  // raw.githubusercontent.com rate-limits bursts (HTTP 429) — 10 parallel
  // fetches on a cold cache can trip it, so retry transient statuses with
  // backoff before conceding a skip.
  let body: Buffer | null = null;
  let lastFailure = 'not attempted';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3_000 * 4 ** (attempt - 1)));
    try {
      const res = await fetch(entry.url, { redirect: 'error' });
      if (res.ok) {
        body = Buffer.from(await res.arrayBuffer());
        break;
      }
      lastFailure = `GET ${entry.url} -> HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break; // 4xx (except 429): retrying won't help
    } catch (err) {
      lastFailure = `GET ${entry.url} failed: ${(err as Error).message}`;
    }
  }
  if (body === null) {
    return { path: null, reason: lastFailure };
  }

  const actual = sha256(body);
  if (actual !== entry.sha256) {
    // Commit-pinned URL returned different bytes: manifest bug or tampering.
    throw new Error(
      `corpus integrity failure for "${entry.name}": expected sha256 ${entry.sha256}, got ${actual} from ${entry.url}`,
    );
  }

  // Write via temp + rename so a crashed run never leaves a truncated cache file.
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, target);
  return { path: target };
}
