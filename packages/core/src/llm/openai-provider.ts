/**
 * OpenAI-family provider. One class serves BOTH:
 *  - `openai`            — the hosted api.openai.com endpoint, and
 *  - `openai-compatible` — any self-hosted server speaking the OpenAI wire
 *                          format (Ollama, vLLM, LM Studio, Groq, Together, …).
 *
 * The two differ in three places, all handled here:
 *  1. Model resolution against `/v1/models` — hosted OpenAI always lists models,
 *     compatible servers may not implement the endpoint at all.
 *  2. The output-token parameter name (`max_completion_tokens` vs `max_tokens`).
 *  3. Structured-output support (`response_format: json_schema`), which many
 *     compatible servers don't honor — so `completeJson` degrades gracefully.
 */
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { extractJsonObject } from '../utils/json-extract.js';
import { logger } from '../utils/logger.js';
import type {
  CompleteJsonOptions,
  CompleteOptions,
  LlmProvider,
  ModelTier,
  ProviderKind,
} from './types.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  baseURL?: string;
  kind: 'openai' | 'openai-compatible';
}

/**
 * Preferred (undated) model id per tier. Model ids rot — a whole family can be
 * retired and a hardcoded snapshot then silently 404s — so the preferred id is
 * only trusted when the live `/v1/models` listing confirms it (mirrors the
 * Anthropic resolver in {@link ../utils/model-resolver}).
 */
const PREFERRED: Record<ModelTier, string> = {
  balanced: 'gpt-4o',
  fast: 'gpt-4o-mini',
};

const TIER_PATTERN: Record<ModelTier, RegExp> = {
  balanced: /gpt-(5|4\.1|4o|4)/i,
  fast: /mini|nano|small|flash|haiku/i,
};

export class OpenAiProvider implements LlmProvider {
  readonly name: string;
  readonly supportsVision = true;
  private readonly client: OpenAI;
  private readonly kind: 'openai' | 'openai-compatible';
  // Resolved once per tier per process: the served-model list rarely changes
  // mid-run, and we don't want a Models API round-trip before every call.
  private readonly modelCache = new Map<ModelTier, string>();
  // The endpoint we talk to, used in error messages so a misconfigured
  // openai-compatible server is obvious from the thrown error alone.
  private readonly baseURL: string;
  // Whether we've already warned about a structured-output downgrade. Warning
  // once per process keeps the log readable when many JSON calls degrade.
  private jsonDowngradeWarned = false;

  constructor(opts: OpenAiProviderOptions) {
    this.kind = opts.kind;
    this.name = opts.kind;
    this.baseURL = opts.baseURL ?? 'https://api.openai.com/v1';
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  /**
   * Resolve a usable model id for a tier against the live `/v1/models` listing,
   * so a retired id can never silently 404 the way a hardcoded snapshot does.
   *
   * Resolution order:
   *  1. An explicit `override` (e.g. a `--model` flag) wins, unchecked — the
   *     caller knows what they want, and a bad id surfaces as a clear API error.
   *  2. The tier's preferred id, **if** the listing contains it.
   *  3. Otherwise the newest served model whose id matches the tier pattern.
   *  4. No match: hosted OpenAI falls back to the preferred id; an
   *     openai-compatible server falls back to its first listed model (or throws
   *     if it lists nothing).
   *  5. Listing throws (server has no `/v1/models`): hosted OpenAI returns the
   *     preferred id WITHOUT caching (so a later call retries); an
   *     openai-compatible server throws — there's nothing safe to guess.
   */
  private async resolveModel(tier: ModelTier, override?: string): Promise<string> {
    if (override) return override;

    const cached = this.modelCache.get(tier);
    if (cached) return cached;

    const preferred = PREFERRED[tier];
    let choice: string;

    let models: { id: string; created?: number }[];
    try {
      const page = await this.client.models.list();
      models = page.data;
    } catch (err) {
      // Transient or unimplemented Models API.
      if (this.kind === 'openai') {
        // Return the fallback for this call WITHOUT caching it, so a later call
        // retries once the API recovers (a poisoned cache would pin the whole
        // process to the fallback id).
        logger.warn(
          `Could not list models (${err instanceof Error ? err.message : err}); using "${preferred}"`,
        );
        return preferred;
      }
      throw new Error('Could not list models; pass --model for openai-compatible providers');
    }

    if (models.some((m) => m.id === preferred)) {
      choice = preferred;
    } else {
      const pattern = TIER_PATTERN[tier];
      const newest = models
        .filter((m) => pattern.test(m.id))
        // `created` is an epoch number (seconds); missing values sort oldest.
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];

      if (newest) {
        logger.warn(`Preferred model "${preferred}" unavailable; using "${newest.id}"`);
        choice = newest.id;
      } else if (this.kind === 'openai') {
        logger.warn(
          `Preferred model "${preferred}" unavailable and no ${tier} model found; trying it anyway`,
        );
        choice = preferred;
      } else if (models[0]) {
        // openai-compatible: no tiered match, but the server lists *something* —
        // use the first model rather than guessing an OpenAI id it won't have.
        logger.warn(`No ${tier} model matched on ${this.baseURL}; using "${models[0].id}"`);
        choice = models[0].id;
      } else {
        throw new Error(`No model available from ${this.baseURL}; pass --model`);
      }
    }

    // Only successful resolutions are cached.
    this.modelCache.set(tier, choice);
    return choice;
  }

  /**
   * Output-token parameter, keyed by provider kind: newer hosted OpenAI models
   * reject `max_tokens` and require `max_completion_tokens`, while many
   * openai-compatible servers only understand the older `max_tokens`.
   */
  private tokenParam(
    maxTokens: number,
  ): { max_completion_tokens: number } | { max_tokens: number } {
    return this.kind === 'openai'
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };
  }

  /** Build the message list: a leading system message only when `system` is set. */
  private buildMessages(prompt: string, system?: string): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  async completeText({ system, prompt, tier, model, maxTokens }: CompleteOptions): Promise<string> {
    const resolved = await this.resolveModel(tier, model);
    const messages = this.buildMessages(prompt, system);

    const res = await this.client.chat.completions.create({
      model: resolved,
      messages,
      ...this.tokenParam(maxTokens),
    });

    return res.choices[0]?.message?.content ?? '';
  }

  async completeJson<T = unknown>({
    system,
    prompt,
    schema,
    tier,
    model,
    maxTokens,
  }: CompleteJsonOptions): Promise<T> {
    const resolved = await this.resolveModel(tier, model);
    const tokenParam = this.tokenParam(maxTokens);

    // Nudge appended to the prompt for the non-native fallbacks, so the model
    // still aims at the schema even without enforced structured output.
    const schemaNudge = `Respond with JSON only that conforms to this JSON Schema:\n${JSON.stringify(schema)}`;

    // 1) Native structured output (`json_schema`). Best fidelity when supported.
    let content: string;
    try {
      const res = await this.client.chat.completions.create({
        model: resolved,
        messages: this.buildMessages(prompt, system),
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'response', strict: true, schema },
        },
        ...tokenParam,
      });
      content = res.choices[0]?.message?.content ?? '';
    } catch {
      this.warnJsonDowngrade();
      try {
        // 2) `json_object` mode + schema-in-prompt: forces valid JSON without
        //    enforcing the schema, which most compatible servers support.
        const messages = this.buildMessages(prompt, system);
        messages.push({ role: 'user', content: schemaNudge });
        const res = await this.client.chat.completions.create({
          model: resolved,
          messages,
          response_format: { type: 'json_object' },
          ...tokenParam,
        });
        content = res.choices[0]?.message?.content ?? '';
      } catch {
        // 3) Plain completion + schema-in-prompt: last resort for servers that
        //    reject `response_format` entirely. Rely on the JSON extractor.
        const messages = this.buildMessages(prompt, system);
        messages.push({ role: 'user', content: schemaNudge });
        const res = await this.client.chat.completions.create({
          model: resolved,
          messages,
          ...tokenParam,
        });
        content = res.choices[0]?.message?.content ?? '';
      }
    }

    const json = extractJsonObject(content);
    if (json === null) throw new Error('OpenAI provider returned unparseable JSON');

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('OpenAI provider returned unparseable JSON');
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('OpenAI provider returned unparseable JSON');
    }

    return parsed as T;
  }

  /** Warn once when structured output is downgraded, so the loss is visible. */
  private warnJsonDowngrade(): void {
    if (this.jsonDowngradeWarned) return;
    this.jsonDowngradeWarned = true;
    logger.warn(
      `${this.name}: native JSON-schema output not supported on ${this.baseURL}; falling back to best-effort JSON parsing`,
    );
  }
}
