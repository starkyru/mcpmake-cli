import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The provider talks to the OpenAI SDK only. We mock the whole `openai` module
 * with a fake client whose `chat.completions.create` and `models.list` are
 * vitest mocks the tests drive — no network, no real SDK. The constructor
 * records the options it was built with so we can assert `baseURL` propagation
 * and inspect the request bodies passed to `create`.
 */

/** The most-recently-constructed fake client, exposed for per-test wiring. */
let lastClient: {
  options: { apiKey?: string; baseURL?: string };
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
  models: { list: ReturnType<typeof vi.fn> };
};

vi.mock('openai', () => {
  class FakeOpenAI {
    options: { apiKey?: string; baseURL?: string };
    chat = { completions: { create: vi.fn() } };
    models = { list: vi.fn() };
    constructor(options: { apiKey?: string; baseURL?: string }) {
      this.options = options;
      lastClient = this as unknown as typeof lastClient;
    }
  }
  return { default: FakeOpenAI };
});

// Silence/observe the logger; warnJsonDowngrade goes through logger.warn.
vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Imported after the mocks are registered.
import { OpenAiProvider } from '../../src/llm/openai-provider.js';
import { logger } from '../../src/utils/logger.js';

/** A successful chat completion response with the given text content. */
function chatResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

/** A successful `/v1/models` page (the SDK shape: `{ data: [...] }`). */
function modelsPage(models: { id: string; created?: number }[]) {
  return { data: models };
}

/** An error shaped like the OpenAI SDK's: it carries an HTTP `status`. */
function apiError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } } as const;

/** Default model listing that resolves the `balanced` tier to `gpt-4o`. */
function listGpt4o() {
  return modelsPage([{ id: 'gpt-4o', created: 1_700_000_000 }]);
}

function makeProvider(kind: 'openai' | 'openai-compatible' = 'openai') {
  return new OpenAiProvider({
    apiKey: 'sk-test',
    baseURL: kind === 'openai' ? undefined : 'https://compat.example.com/v1',
    kind,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OpenAiProvider.completeJson — 3-tier fallback', () => {
  it('returns the json_schema result on the happy path (no downgrade)', async () => {
    const provider = makeProvider('openai');
    const create = vi.fn();
    // 1st call: models.list (resolveModel). Use a dedicated mock for that.
    lastClient.models.list.mockResolvedValue(listGpt4o());
    // Tier 1 (json_schema) succeeds.
    create.mockResolvedValueOnce(chatResponse('{"ok":true}'));
    lastClient.chat.completions.create = create;

    const out = await provider.completeJson({
      prompt: 'p',
      schema: SCHEMA,
      tier: 'balanced',
      maxTokens: 256,
    });

    expect(out).toEqual({ ok: true });
    // Exactly one chat call: native structured output was honored.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema: SCHEMA },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('downgrades json_schema -> json_object on a 400, warning once', async () => {
    const provider = makeProvider('openai');
    lastClient.models.list.mockResolvedValue(listGpt4o());
    const create = vi.fn();
    create
      .mockRejectedValueOnce(apiError(400, 'response_format not supported')) // tier 1
      .mockResolvedValueOnce(chatResponse('{"ok":true}')); // tier 2 succeeds
    lastClient.chat.completions.create = create;

    const out = await provider.completeJson({
      prompt: 'p',
      schema: SCHEMA,
      tier: 'balanced',
      maxTokens: 256,
    });

    expect(out).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].response_format).toEqual({ type: 'json_object' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('downgrades all the way to prompt-extract on consecutive 400s, warning once', async () => {
    const provider = makeProvider('openai');
    lastClient.models.list.mockResolvedValue(listGpt4o());
    const create = vi.fn();
    create
      .mockRejectedValueOnce(apiError(400)) // tier 1 (json_schema)
      .mockRejectedValueOnce(apiError(400)) // tier 2 (json_object)
      .mockResolvedValueOnce(chatResponse('Here you go:\n```json\n{"ok":true}\n```')); // tier 3
    lastClient.chat.completions.create = create;

    const out = await provider.completeJson({
      prompt: 'p',
      schema: SCHEMA,
      tier: 'balanced',
      maxTokens: 256,
    });

    expect(out).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(3);
    // Tier 3 sends no response_format at all (plain completion).
    expect(create.mock.calls[2][0].response_format).toBeUndefined();
    // warnJsonDowngrade fires exactly once across the whole downgrade run.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAiProvider.completeJson — Q8 regression (non-400 rethrows)', () => {
  it('rethrows a 401 immediately without downgrading', async () => {
    const provider = makeProvider('openai');
    lastClient.models.list.mockResolvedValue(listGpt4o());
    const create = vi.fn();
    create.mockRejectedValueOnce(apiError(401, 'invalid api key'));
    lastClient.chat.completions.create = create;

    await expect(
      provider.completeJson({ prompt: 'p', schema: SCHEMA, tier: 'balanced', maxTokens: 256 }),
    ).rejects.toThrow('invalid api key');

    // No downgrade: only the tier-1 attempt was made.
    expect(create).toHaveBeenCalledTimes(1);
    // The misleading "unparseable JSON" message must NOT surface.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('rethrows a 429 immediately without downgrading', async () => {
    const provider = makeProvider('openai');
    lastClient.models.list.mockResolvedValue(listGpt4o());
    const create = vi.fn();
    create.mockRejectedValueOnce(apiError(429, 'rate limited'));
    lastClient.chat.completions.create = create;

    await expect(
      provider.completeJson({ prompt: 'p', schema: SCHEMA, tier: 'balanced', maxTokens: 256 }),
    ).rejects.toThrow('rate limited');

    expect(create).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('rethrows a non-400 surfacing at tier 2 without dropping to tier 3', async () => {
    const provider = makeProvider('openai');
    lastClient.models.list.mockResolvedValue(listGpt4o());
    const create = vi.fn();
    create
      .mockRejectedValueOnce(apiError(400)) // tier 1: legit format downgrade
      .mockRejectedValueOnce(apiError(500, 'upstream exploded')); // tier 2: hard error
    lastClient.chat.completions.create = create;

    await expect(
      provider.completeJson({ prompt: 'p', schema: SCHEMA, tier: 'balanced', maxTokens: 256 }),
    ).rejects.toThrow('upstream exploded');

    // Tier 3 must NOT be attempted after a non-400 at tier 2.
    expect(create).toHaveBeenCalledTimes(2);
    // The single downgrade to tier 2 still warned exactly once.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAiProvider.resolveModel (via completeText)', () => {
  it('uses an explicit override and never lists models', async () => {
    const provider = makeProvider('openai');
    lastClient.chat.completions.create = vi.fn().mockResolvedValue(chatResponse('hi'));

    await provider.completeText({
      prompt: 'p',
      tier: 'balanced',
      model: 'gpt-custom-override',
      maxTokens: 16,
    });

    expect(lastClient.models.list).not.toHaveBeenCalled();
    expect(lastClient.chat.completions.create.mock.calls[0][0].model).toBe('gpt-custom-override');
  });

  it('picks the preferred id when the listing contains it', async () => {
    const provider = makeProvider('openai');
    lastClient.models.list.mockResolvedValue(
      modelsPage([
        { id: 'gpt-3.5-turbo', created: 1_600_000_000 },
        { id: 'gpt-4o', created: 1_700_000_000 },
      ]),
    );
    lastClient.chat.completions.create = vi.fn().mockResolvedValue(chatResponse('hi'));

    await provider.completeText({ prompt: 'p', tier: 'balanced', maxTokens: 16 });

    expect(lastClient.chat.completions.create.mock.calls[0][0].model).toBe('gpt-4o');
  });

  it('falls back to the newest tier-matching model by `created` when no preferred id', async () => {
    const provider = makeProvider('openai');
    // No 'gpt-4o' present; two balanced-pattern matches, newest by `created` wins.
    lastClient.models.list.mockResolvedValue(
      modelsPage([
        { id: 'gpt-4.1-old', created: 1_600_000_000 },
        { id: 'gpt-4.1-new', created: 1_900_000_000 },
        { id: 'text-embedding-3', created: 2_000_000_000 }, // newer but no tier match
      ]),
    );
    lastClient.chat.completions.create = vi.fn().mockResolvedValue(chatResponse('hi'));

    await provider.completeText({ prompt: 'p', tier: 'balanced', maxTokens: 16 });

    expect(lastClient.chat.completions.create.mock.calls[0][0].model).toBe('gpt-4.1-new');
  });

  it('throws when an openai-compatible server lists nothing', async () => {
    const provider = makeProvider('openai-compatible');
    lastClient.models.list.mockResolvedValue(modelsPage([]));
    lastClient.chat.completions.create = vi.fn();

    await expect(
      provider.completeText({ prompt: 'p', tier: 'balanced', maxTokens: 16 }),
    ).rejects.toThrow(/No model available/);
    expect(lastClient.chat.completions.create).not.toHaveBeenCalled();
  });
});

describe('OpenAiProvider — openai vs openai-compatible divergence', () => {
  it('on list failure: openai falls back to the preferred id (no throw)', async () => {
    const provider = makeProvider('openai');
    lastClient.models.list.mockRejectedValue(apiError(503, 'models api down'));
    lastClient.chat.completions.create = vi.fn().mockResolvedValue(chatResponse('hi'));

    const out = await provider.completeText({ prompt: 'p', tier: 'balanced', maxTokens: 16 });

    expect(out).toBe('hi');
    // Preferred id used as the resilient fallback.
    expect(lastClient.chat.completions.create.mock.calls[0][0].model).toBe('gpt-4o');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('on list failure: openai-compatible throws (nothing safe to guess)', async () => {
    const provider = makeProvider('openai-compatible');
    lastClient.models.list.mockRejectedValue(apiError(404, 'no models endpoint'));
    lastClient.chat.completions.create = vi.fn();

    await expect(
      provider.completeText({ prompt: 'p', tier: 'balanced', maxTokens: 16 }),
    ).rejects.toThrow(/Could not list models; pass --model/);
    expect(lastClient.chat.completions.create).not.toHaveBeenCalled();
  });

  it('openai sends max_completion_tokens (not max_tokens)', async () => {
    const provider = makeProvider('openai');
    lastClient.models.list.mockResolvedValue(listGpt4o());
    lastClient.chat.completions.create = vi.fn().mockResolvedValue(chatResponse('hi'));

    await provider.completeText({ prompt: 'p', tier: 'balanced', maxTokens: 321 });

    const body = lastClient.chat.completions.create.mock.calls[0][0];
    expect(body.max_completion_tokens).toBe(321);
    expect(body.max_tokens).toBeUndefined();
  });

  it('openai-compatible sends max_tokens (not max_completion_tokens)', async () => {
    const provider = makeProvider('openai-compatible');
    // Compatible server lists its own model; first listed model is used.
    lastClient.models.list.mockResolvedValue(modelsPage([{ id: 'llama-3.1', created: 1 }]));
    lastClient.chat.completions.create = vi.fn().mockResolvedValue(chatResponse('hi'));

    await provider.completeText({ prompt: 'p', tier: 'balanced', maxTokens: 321 });

    const body = lastClient.chat.completions.create.mock.calls[0][0];
    expect(body.max_tokens).toBe(321);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('passes the constructed baseURL through to the SDK client', () => {
    makeProvider('openai-compatible');
    expect(lastClient.options.baseURL).toBe('https://compat.example.com/v1');
  });
});
