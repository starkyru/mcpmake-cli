import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { logger } from '../utils/logger.js';
import { isDangerousKey } from '../utils/sanitize.js';

interface OverlayAction {
  target: string;
  update?: Record<string, unknown>;
  remove?: boolean;
}

interface OverlayDocument {
  overlay: string;
  info?: Record<string, unknown>;
  actions: OverlayAction[];
}

/**
 * Applies an OpenAPI Overlay document to a spec, modifying it in place.
 *
 * Supports simplified JSONPath-like targets:
 * - `$.paths['/users'].get`       exact path + method
 * - `$.paths['/users'].get.x-foo` exact nested field
 * - `$.paths['/admin/*']`         wildcard match on path prefix
 * - `$.components.schemas.User`   schema-level targeting
 */
export async function applyOverlay(
  spec: Record<string, unknown>,
  overlayPath: string,
): Promise<void> {
  const raw = await readFile(overlayPath, 'utf-8');
  const overlay = parseOverlay(raw);

  logger.info(`Applying overlay: ${overlayPath} (${overlay.actions.length} actions)`);

  for (const action of overlay.actions) {
    applyAction(spec, action);
  }
}

function parseOverlay(content: string): OverlayDocument {
  let doc: OverlayDocument;
  try {
    doc = parseYaml(content) as OverlayDocument;
  } catch {
    doc = JSON.parse(content) as OverlayDocument;
  }

  if (!doc.actions || !Array.isArray(doc.actions)) {
    throw new Error('Overlay document must contain an "actions" array');
  }

  return doc;
}

function applyAction(spec: Record<string, unknown>, action: OverlayAction): void {
  const segments = parseTarget(action.target);
  if (segments.length === 0) return;

  // Handle wildcard matching
  const wildcardIdx = segments.findIndex((s) => s.includes('*'));

  if (wildcardIdx >= 0) {
    applyWildcardAction(spec, segments, wildcardIdx, action);
  } else {
    applySingleAction(spec, segments, action);
  }
}

function applySingleAction(
  spec: Record<string, unknown>,
  segments: string[],
  action: OverlayAction,
): void {
  if (action.remove) {
    // Navigate to parent, then delete the last key
    const parent = navigateTo(spec, segments.slice(0, -1));
    if (parent && typeof parent === 'object') {
      const lastKey = segments[segments.length - 1];
      delete (parent as Record<string, unknown>)[lastKey];
      logger.info(`Overlay: removed ${segments.join('.')}`);
    }
  } else if (action.update) {
    const target = navigateTo(spec, segments);
    if (target && typeof target === 'object') {
      deepMerge(target as Record<string, unknown>, action.update);
      logger.info(`Overlay: updated ${segments.join('.')}`);
    } else {
      // If target doesn't exist, try creating it by setting on parent
      const parent = navigateTo(spec, segments.slice(0, -1));
      const lastKey = segments[segments.length - 1];
      if (parent && typeof parent === 'object' && !isDangerousKey(lastKey)) {
        (parent as Record<string, unknown>)[lastKey] = action.update;
        logger.info(`Overlay: created ${segments.join('.')}`);
      } else {
        logger.warn(`Overlay: target not found: ${segments.join('.')}`);
      }
    }
  }
}

function applyWildcardAction(
  spec: Record<string, unknown>,
  segments: string[],
  wildcardIdx: number,
  action: OverlayAction,
): void {
  // Navigate to parent of the wildcard segment
  const parentSegments = segments.slice(0, wildcardIdx);
  const parent = navigateTo(spec, parentSegments);
  if (!parent || typeof parent !== 'object') return;

  const wildcardPattern = segments[wildcardIdx];
  const remainingSegments = segments.slice(wildcardIdx + 1);

  // Match keys against the wildcard pattern
  const matchedKeys = Object.keys(parent as Record<string, unknown>).filter((key) =>
    wildcardMatch(wildcardPattern, key),
  );

  for (const key of matchedKeys) {
    const fullSegments = [...parentSegments, key, ...remainingSegments];
    applySingleAction(spec, fullSegments, action);
  }
}

/**
 * Parses a JSONPath-like target string into segments.
 * `$.paths['/users'].get` -> ['paths', '/users', 'get']
 */
function parseTarget(target: string): string[] {
  const segments: string[] = [];
  let current = target;

  // Remove leading $. or $
  if (current.startsWith('$.')) {
    current = current.slice(2);
  } else if (current.startsWith('$')) {
    current = current.slice(1);
  }

  while (current.length > 0) {
    if (current.startsWith('[')) {
      // Bracket notation: ['key'] or ['/path']
      const closeIdx = current.indexOf(']');
      if (closeIdx < 0) break;
      let key = current.slice(1, closeIdx);
      // Strip surrounding quotes
      if (
        (key.startsWith("'") && key.endsWith("'")) ||
        (key.startsWith('"') && key.endsWith('"'))
      ) {
        key = key.slice(1, -1);
      }
      segments.push(key);
      current = current.slice(closeIdx + 1);
      if (current.startsWith('.')) current = current.slice(1);
    } else {
      // Dot notation: get the next segment up to . or [
      const dotIdx = current.indexOf('.');
      const bracketIdx = current.indexOf('[');
      let end: number;
      if (dotIdx < 0 && bracketIdx < 0) {
        end = current.length;
      } else if (dotIdx < 0) {
        end = bracketIdx;
      } else if (bracketIdx < 0) {
        end = dotIdx;
      } else {
        end = Math.min(dotIdx, bracketIdx);
      }

      const segment = current.slice(0, end);
      if (segment.length > 0) {
        segments.push(segment);
      }
      current = current.slice(end);
      if (current.startsWith('.')) current = current.slice(1);
    }
  }

  return segments;
}

function navigateTo(obj: unknown, segments: string[]): unknown {
  let current = obj;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    // Never traverse into prototype-pollution keys from an untrusted overlay.
    if (isDangerousKey(segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  depth = 0,
): void {
  // A4-2: cap recursion depth to prevent stack-overflow DoS from deeply nested
  // overlay `update` payloads. At the limit we leave the target subtree as-is.
  if (depth > 50) {
    logger.warn('Overlay: update nesting exceeds 50 levels — deeper fields not merged');
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    // Skip prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
    // Both YAML and JSON parse a literal `__proto__` as an own enumerable key,
    // so without this guard `update: { __proto__: {...} }` pollutes the prototype.
    if (isDangerousKey(key)) continue;
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
        depth + 1,
      );
    } else {
      target[key] = value;
    }
  }
}

// A4-1: Match a spec key against a wildcard pattern where `*` matches any run
// of characters (including `/`, since OpenAPI path keys like `/users/{id}`
// legitimately contain separators). Implemented as a linear two-pointer glob
// scan rather than a `.*` regex: an adversarial multi-`*` `--overlay` target
// against a long non-matching key would make a `.*` regex backtrack
// exponentially (ReDoS, freezing the event loop). This scan is O(n*m) with no
// backtracking. All non-`*` characters match literally.
function wildcardMatch(pattern: string, str: string): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = -1;
  while (s < str.length) {
    if (p < pattern.length && pattern[p] === '*') {
      // Record the star position and provisionally match zero characters.
      starP = p;
      starS = s;
      p++;
    } else if (p < pattern.length && pattern[p] === str[s]) {
      p++;
      s++;
    } else if (starP !== -1) {
      // Backtrack to the last `*` and let it consume one more character.
      p = starP + 1;
      starS++;
      s = starS;
    } else {
      return false;
    }
  }
  // Trailing `*`s in the pattern match the empty string.
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
