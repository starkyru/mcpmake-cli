/**
 * LLM provider selection. Reads the environment and builds the active
 * {@link LlmProvider}; CLI flags populate that environment (see the CLI's
 * provider options) so core code never needs a provider parameter threaded
 * through every call.
 */
import { logger } from '../utils/logger.js';
import { type LlmProvider, type ProviderKind, PROVIDER_KINDS } from './types.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAiProvider } from './openai-provider.js';

export * from './types.js';

/** Resolve the configured provider kind from `MCPMAKE_LLM_PROVIDER` (default: anthropic). */
export function resolveProviderKind(): ProviderKind {
  const raw = process.env.MCPMAKE_LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) return 'anthropic';
  if ((PROVIDER_KINDS as readonly string[]).includes(raw)) return raw as ProviderKind;
  logger.warn(`Unknown MCPMAKE_LLM_PROVIDER "${raw}" — falling back to "anthropic"`);
  return 'anthropic';
}

/** The env var that holds the API key for a given provider kind. */
function keyVarFor(kind: ProviderKind): string {
  return kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
}

/**
 * Build the active LLM provider from the environment, or return `null` when it
 * is not usable (missing key, or an `openai-compatible` setup with no base
 * URL). Optional AI steps treat `null` as "warn and skip", exactly as the old
 * direct `ANTHROPIC_API_KEY` checks did. Required features should call
 * {@link requireLlmProvider} instead so they fail with a clear message.
 */
export function getLlmProvider(): LlmProvider | null {
  const kind = resolveProviderKind();

  if (kind === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return null;
    return new AnthropicProvider({
      apiKey,
      baseURL: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
    });
  }

  // openai / openai-compatible
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = process.env.OPENAI_BASE_URL?.trim() || undefined;

  if (kind === 'openai') {
    if (!apiKey) return null;
    return new OpenAiProvider({ apiKey, baseURL, kind });
  }

  // openai-compatible: self-hosted servers (Ollama, vLLM, …) frequently need no
  // key, but they do need an explicit endpoint.
  if (!baseURL) {
    logger.warn(
      'MCPMAKE_LLM_PROVIDER=openai-compatible requires OPENAI_BASE_URL — skipping AI step',
    );
    return null;
  }
  return new OpenAiProvider({ apiKey: apiKey || 'not-needed', baseURL, kind });
}

/**
 * Like {@link getLlmProvider} but throws a provider-aware error instead of
 * returning null — for features that cannot degrade (spec generation, goal
 * crawl).
 */
export function requireLlmProvider(feature: string): LlmProvider {
  const provider = getLlmProvider();
  if (provider) return provider;

  const kind = resolveProviderKind();
  const needs = keyVarFor(kind) + (kind === 'openai-compatible' ? ' and OPENAI_BASE_URL' : '');
  throw new Error(`${feature} requires an LLM provider. Set ${needs} (active provider: ${kind}).`);
}
