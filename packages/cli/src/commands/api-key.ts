/**
 * Shared `--api-key` / `--provider` support for commands that call an LLM (LLM
 * tool naming, goal-directed crawl, semantic analysis, selector healing, spec
 * generation).
 *
 * The core library reads its provider/key env vars (`MCPMAKE_LLM_PROVIDER`,
 * `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`) lazily, at each call
 * site. So rather than threading a key through every function signature, the
 * flags simply populate those env vars before the command's work begins.
 *
 * `--api-key` is provider-aware: it targets `ANTHROPIC_API_KEY` for the default
 * `anthropic` provider, and `OPENAI_API_KEY` for `openai` / `openai-compatible`.
 *
 * Security: passing a secret on the command line is less safe than the env var —
 * argv is visible to other users via the process list (`ps`, /proc) and is
 * recorded in shell history. The flag is a convenience; the corresponding env
 * var remains the recommended path. See the README.
 */
import { logger } from '@mcpmake/core';

/** Citty arg definition — spread into an LLM-using command's `args` block. */
export const apiKeyArg = {
  type: 'string' as const,
  description:
    'Anthropic API key for AI features (overrides ANTHROPIC_API_KEY; note: visible in shell history/process list)',
};

/** Citty arg for choosing the LLM backend — spread into an LLM-using command's `args`. */
export const providerArg = {
  type: 'string' as const,
  description:
    'LLM provider: anthropic (default), openai, or openai-compatible (uses OPENAI_API_KEY / OPENAI_BASE_URL)',
};

/**
 * If `--provider` and/or `--api-key` were passed, copy them into the env vars the
 * core LLM factory reads (`MCPMAKE_LLM_PROVIDER` plus the provider-appropriate
 * key var). Call once at the top of a command's `run()`, before any core function
 * that may hit the LLM. A blank flag is ignored so it never clobbers an
 * already-exported env var with an empty string.
 */
export function applyApiKey(args: Record<string, unknown>): void {
  // Provider selection first, so we know which key var --api-key targets.
  const providerRaw = args['provider'];
  if (typeof providerRaw === 'string' && providerRaw.trim()) {
    process.env.MCPMAKE_LLM_PROVIDER = providerRaw.trim().toLowerCase();
  }

  const raw = args['api-key'];
  if (typeof raw !== 'string') return;
  const key = raw.trim();
  if (!key) return;

  const provider = (process.env.MCPMAKE_LLM_PROVIDER ?? 'anthropic').toLowerCase();
  const keyVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  if (process.env[keyVar] && process.env[keyVar] !== key) {
    logger.warn(`--api-key overrides the ${keyVar} already set in the environment`);
  }
  process.env[keyVar] = key;
}

/**
 * Citty arg definition for selecting the LLM model — spread into an LLM-using
 * command's `args` block. Forwarded to the core helpers, which resolve it
 * against the live Models API (a bad id surfaces as a clear API error).
 */
export const modelArg = {
  type: 'string' as const,
  alias: 'm' as const,
  description:
    'LLM model to use (default: auto-resolved; prefers claude-sonnet-4-6 / claude-haiku-4-5)',
};
