/**
 * Provider-agnostic LLM abstraction.
 *
 * The CLI's AI features (spec generation, tool naming, semantic naming,
 * goal-directed crawl, selector healing) used to call `@anthropic-ai/sdk`
 * directly. They now go through an {@link LlmProvider} so the same features can
 * run against Claude, OpenAI/ChatGPT, or any OpenAI-compatible endpoint
 * (Ollama, vLLM, LM Studio, Groq, Together, OpenRouter, …).
 *
 * The active provider is selected by environment (see `getLlmProvider`):
 * `MCPMAKE_LLM_PROVIDER` + the matching key/base-url vars. Anthropic stays the
 * default so existing setups are unaffected.
 */

/** Model tiers used across the generator. */
export type ModelTier = 'balanced' | 'fast';

/** Which backend the active provider talks to. */
export type ProviderKind = 'anthropic' | 'openai' | 'openai-compatible';

/** All supported provider kinds, for validation + help text. */
export const PROVIDER_KINDS: readonly ProviderKind[] = ['anthropic', 'openai', 'openai-compatible'];

/** A single completion request. */
export interface CompleteOptions {
  /** Optional system instruction. */
  system?: string;
  /** User prompt. */
  prompt: string;
  /** Tier resolved to a concrete model when `model` is not given. */
  tier: ModelTier;
  /** Explicit model id — wins over tier resolution, passed through unchecked. */
  model?: string;
  /** Hard cap on output tokens. */
  maxTokens: number;
}

/** A completion request constrained to a JSON Schema. */
export interface CompleteJsonOptions extends CompleteOptions {
  /** JSON Schema the response must satisfy (flat/non-recursive for native modes). */
  schema: Record<string, unknown>;
}

/**
 * One LLM backend. Implementations hide SDK + wire-format differences:
 * structured output (Anthropic `messages.parse` vs OpenAI `response_format`),
 * model resolution (live model listing per provider), and text completion.
 */
export interface LlmProvider {
  /** Human-readable provider id, e.g. `anthropic` / `openai` / `openai-compatible`. */
  readonly name: string;
  /** Whether this provider/model class can accept image inputs (future use). */
  readonly supportsVision: boolean;

  /**
   * Plain text completion. Returns the model's raw text (callers that want JSON
   * run it through `utils/json-extract`). Throws on transport/API failure.
   */
  completeText(options: CompleteOptions): Promise<string>;

  /**
   * Schema-constrained completion returning the parsed object. Uses the
   * provider's native structured-output mode when available, otherwise falls
   * back to a text completion parsed with the shared JSON extractor. Throws if
   * the response cannot be parsed into an object.
   */
  completeJson<T = unknown>(options: CompleteJsonOptions): Promise<T>;
}
