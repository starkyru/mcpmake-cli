/**
 * Shared `--api-key` support for commands that call Claude (LLM tool naming,
 * goal-directed crawl, semantic analysis, selector healing, spec generation).
 *
 * The core library reads `process.env.ANTHROPIC_API_KEY` lazily, at each call
 * site. So rather than threading a key through every function signature, the
 * flag simply populates that env var before the command's work begins.
 *
 * Security: passing a secret on the command line is less safe than the env var —
 * argv is visible to other users via the process list (`ps`, /proc) and is
 * recorded in shell history. The flag is a convenience; `ANTHROPIC_API_KEY`
 * remains the recommended path. See the README.
 */
import { logger } from '@mcpmake/core';

/** Citty arg definition — spread into an LLM-using command's `args` block. */
export const apiKeyArg = {
  type: 'string' as const,
  description:
    'Anthropic API key for AI features (overrides ANTHROPIC_API_KEY; note: visible in shell history/process list)',
};

/**
 * If `--api-key` was passed, copy it into `process.env.ANTHROPIC_API_KEY` so the
 * core LLM helpers pick it up. Call once at the top of a command's `run()`,
 * before any core function that may hit the Anthropic API. A blank flag is
 * ignored so it never clobbers an already-exported env var with an empty string.
 */
export function applyApiKey(args: Record<string, unknown>): void {
  const raw = args['api-key'];
  if (typeof raw !== 'string') return;
  const key = raw.trim();
  if (!key) return;
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== key) {
    logger.warn('--api-key overrides the ANTHROPIC_API_KEY already set in the environment');
  }
  process.env.ANTHROPIC_API_KEY = key;
}
