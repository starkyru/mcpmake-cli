import type Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';

/**
 * Model tiers used across the generator. Each maps to a preferred undated alias
 * plus a name pattern used to auto-pick a replacement if that alias is ever
 * retired.
 */
export type ModelTier = 'balanced' | 'fast';

/**
 * Preferred (undated) alias per tier. Undated aliases track the latest snapshot,
 * but a whole family can still be retired — so the alias is only used when the
 * live Models API confirms it exists (see {@link resolveModel}).
 */
const PREFERRED: Record<ModelTier, string> = {
  balanced: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5',
};

const TIER_PATTERN: Record<ModelTier, RegExp> = {
  balanced: /sonnet/i,
  fast: /haiku/i,
};

// Resolved once per tier per process: the served-model list rarely changes
// mid-run, and we don't want a Models API round-trip before every call.
const cache = new Map<ModelTier, string>();

/**
 * Resolve a usable model id for a tier against the live Models API, so a retired
 * model id can never silently 404 the way a hardcoded snapshot does.
 *
 * Resolution order:
 *  1. An explicit `override` (e.g. a `--model` CLI flag) wins, unchecked — the
 *     caller knows what they want, and a bad id surfaces as a clear API error
 *     rather than being second-guessed here.
 *  2. The tier's preferred alias, **if** the Models API lists it.
 *  3. Otherwise the newest served model whose id/name matches the tier.
 *  4. If the Models API can't be reached, the preferred alias as a last resort.
 */
export async function resolveModel(
  client: Anthropic,
  tier: ModelTier,
  override?: string,
): Promise<string> {
  if (override) return override;

  const cached = cache.get(tier);
  if (cached) return cached;

  const preferred = PREFERRED[tier];
  let choice = preferred;

  try {
    const models: { id: string; display_name: string; created_at: string }[] = [];
    for await (const m of client.models.list()) {
      models.push({ id: m.id, display_name: m.display_name, created_at: m.created_at });
    }

    if (!models.some((m) => m.id === preferred)) {
      const pattern = TIER_PATTERN[tier];
      const newest = models
        .filter((m) => pattern.test(m.id) || pattern.test(m.display_name))
        // RFC 3339 timestamps sort correctly as strings (ISO 8601, newest last).
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (newest) {
        logger.warn(`Preferred model "${preferred}" unavailable; using "${newest.id}"`);
        choice = newest.id;
      } else {
        logger.warn(
          `Preferred model "${preferred}" unavailable and no ${tier} model found; trying it anyway`,
        );
      }
    }
  } catch (err) {
    // Transient Models API failure: return the fallback for this call WITHOUT
    // caching it, so a later call retries once the API recovers (a poisoned
    // cache would pin the whole process to the fallback alias).
    logger.warn(
      `Could not list models (${err instanceof Error ? err.message : err}); using "${preferred}"`,
    );
    return preferred;
  }

  // Only successful resolutions are cached — the served-model list rarely
  // changes mid-run, so one API round-trip per tier is enough.
  cache.set(tier, choice);
  return choice;
}
