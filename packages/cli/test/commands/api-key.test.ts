import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyApiKey } from '../../src/commands/api-key.js';

describe('applyApiKey', () => {
  const original = process.env.ANTHROPIC_API_KEY;
  const originalProvider = process.env.MCPMAKE_LLM_PROVIDER;
  const originalOpenai = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MCPMAKE_LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
    if (originalProvider === undefined) delete process.env.MCPMAKE_LLM_PROVIDER;
    else process.env.MCPMAKE_LLM_PROVIDER = originalProvider;
    if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenai;
    vi.restoreAllMocks();
  });

  it('copies --api-key into the env var so core LLM helpers pick it up', () => {
    applyApiKey({ 'api-key': 'sk-ant-from-flag' });
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-from-flag');
  });

  it('trims surrounding whitespace', () => {
    applyApiKey({ 'api-key': '  sk-ant-padded  ' });
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-padded');
  });

  it('leaves an existing env var untouched when the flag is absent', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    applyApiKey({});
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-from-env');
  });

  it('does not clobber the env var with a blank flag', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    applyApiKey({ 'api-key': '   ' });
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-from-env');
  });

  it('ignores a non-string flag value', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    applyApiKey({ 'api-key': true });
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-from-env');
  });

  it('overrides an existing env var when the flag is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    applyApiKey({ 'api-key': 'sk-ant-from-flag' });
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-from-flag');
  });

  it('targets OPENAI_API_KEY when --provider openai is set', () => {
    applyApiKey({ provider: 'openai', 'api-key': 'sk-openai' });
    expect(process.env.OPENAI_API_KEY).toBe('sk-openai');
    expect(process.env.MCPMAKE_LLM_PROVIDER).toBe('openai');
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('sets the provider env var without a key for openai-compatible', () => {
    applyApiKey({ provider: 'openai-compatible' });
    expect(process.env.MCPMAKE_LLM_PROVIDER).toBe('openai-compatible');
  });

  it('lowercases the provider name', () => {
    applyApiKey({ provider: 'OpenAI' });
    expect(process.env.MCPMAKE_LLM_PROVIDER).toBe('openai');
  });

  it('defaults to ANTHROPIC_API_KEY when no provider is given (back-compat)', () => {
    applyApiKey({ 'api-key': 'sk-x' });
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-x');
  });
});
