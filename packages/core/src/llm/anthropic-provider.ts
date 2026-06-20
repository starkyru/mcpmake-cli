/**
 * Anthropic-backed {@link LlmProvider}. Wraps `@anthropic-ai/sdk`, hiding its
 * wire-format details behind the provider-agnostic interface: text completion
 * via `messages.create` and schema-constrained completion via the native
 * structured-output path (`messages.parse` + `jsonSchemaOutputFormat`). Model
 * ids are resolved against the live Models API (see {@link resolveModel}) so a
 * retired snapshot can't silently 404.
 */
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { resolveModel } from '../utils/model-resolver.js';
import type { CompleteJsonOptions, CompleteOptions, LlmProvider } from './types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly supportsVision = true;
  private readonly client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async completeText({ system, prompt, tier, model, maxTokens }: CompleteOptions): Promise<string> {
    const resolved = await resolveModel(this.client, tier, model);

    const message = await this.client.messages.create({
      model: resolved,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content[0];
    return block?.type === 'text' ? block.text : '';
  }

  async completeJson<T = unknown>({
    system,
    prompt,
    schema,
    tier,
    model,
    maxTokens,
  }: CompleteJsonOptions): Promise<T> {
    const resolved = await resolveModel(this.client, tier, model);

    const message = await this.client.messages.parse({
      model: resolved,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      output_config: {
        // `schema` is the interface's `Record<string, unknown>`; the helper wants
        // a stricter JSON-schema type, so cast minimally to keep the public
        // signature intact.
        format: jsonSchemaOutputFormat(schema as Parameters<typeof jsonSchemaOutputFormat>[0]),
      },
    });

    const out = message.parsed_output;
    if (out == null) throw new Error('Anthropic returned no structured output');
    return out as T;
  }
}
