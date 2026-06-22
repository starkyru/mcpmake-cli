import { createHash } from 'node:crypto';
import type { CodeUnit } from './code-writer.js';

/**
 * Determinism gate for the emitted file tree.
 *
 * The managed-Sync / "regenerate → diff → maintenance PR" flow only works if regenerating a
 * server from the SAME inputs yields byte-identical output — otherwise every regen shows
 * spurious diffs and opens noise PRs. `normalizeTree` collapses the two avoidable sources of
 * cross-run variance — file ORDER and path SPELLING (OS separators, redundant `./`) — into one
 * canonical form, and surfaces a genuine collision (same path, different bytes) as an error
 * rather than silently picking a winner. `treeFingerprint` reduces a canonical tree to a single
 * digest so a caller can answer "did anything actually change?" without a full file-by-file diff.
 *
 * It deliberately does NOT rewrite file CONTENT (line endings, whitespace): the bytes are the
 * artifact the user ships, so normalization must be path/order only. Residual content
 * non-determinism (a baked timestamp, a random id) is a generator bug — the determinism test
 * around the real emitter is what catches it; this gate just makes that test meaningful.
 */

/**
 * Locale-independent byte-wise string comparison. `localeCompare` is NOT used: its ordering
 * depends on the host locale/ICU data, which would make the canonical order itself
 * non-deterministic across machines — exactly what this module exists to prevent.
 */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonicalize a relative path: Windows separators → POSIX `/`, collapse repeated slashes and
 * mid-path `/./` segments, strip a leading `./` and any trailing `/`. This matters for the
 * dedup contract: `foo/./bar`, `foo//bar`, and `foo/bar/` all resolve to the SAME file on disk,
 * so they must canonicalize identically here — otherwise two units differing only in path
 * spelling slip past the collision check and `writeCodeUnits` silently last-write-wins. `..`
 * segments are NOT resolved (that would need a real path stack); they are rejected by the caller.
 */
function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/\.\//g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

/** True if any path segment is exactly `..` (an unresolved traversal the gate must reject). */
function hasDotDotSegment(filePath: string): boolean {
  return filePath.split('/').some((segment) => segment === '..');
}

/**
 * Return the units in canonical form: POSIX-normalized paths, de-duplicated, sorted byte-wise by
 * path. Two unit arrays that describe the same logical tree (any order, either separator style)
 * normalize to deeply-equal arrays. Throws on an empty/`.`/`..`-bearing path or a path that
 * appears twice with DIFFERENT content (a real collision a determinism gate must not hide). Does
 * not mutate input.
 */
export function normalizeTree(units: CodeUnit[]): CodeUnit[] {
  const byPath = new Map<string, string>();
  for (const unit of units) {
    const filePath = normalizePath(unit.filePath);
    if (filePath === '' || filePath === '.' || hasDotDotSegment(filePath)) {
      throw new Error(
        `normalizeTree: empty or invalid file path: ${JSON.stringify(unit.filePath)}`,
      );
    }
    const existing = byPath.get(filePath);
    if (existing !== undefined && existing !== unit.content) {
      throw new Error(
        `normalizeTree: conflicting duplicate path "${filePath}" — same path emitted with ` +
          `different content (non-deterministic or colliding generator output).`,
      );
    }
    byPath.set(filePath, unit.content);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => byteCompare(a, b))
    .map(([filePath, content]) => ({ filePath, content }));
}

/**
 * Sha-256 digest of the canonical tree. Same logical tree → same digest; any path or content
 * change → a different digest. The serialization is length-prefixed (byte length of each path
 * and content, plus the unit count) so it is injective — no two distinct trees can collide by a
 * delimiter appearing inside a path or file body.
 */
export function treeFingerprint(units: CodeUnit[]): string {
  const canonical = normalizeTree(units);
  const hash = createHash('sha256');
  hash.update(`mcpmake-tree\n${canonical.length}\n`);
  for (const { filePath, content } of canonical) {
    hash.update(`${Buffer.byteLength(filePath, 'utf8')}\n${filePath}\n`);
    hash.update(`${Buffer.byteLength(content, 'utf8')}\n${content}\n`);
  }
  return hash.digest('hex');
}
