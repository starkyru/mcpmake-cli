import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLlmProvider, requireLlmProvider, resolveProviderKind } from '../../src/llm/index.js';

describe('provider selection', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalOpenaiKey = process.env.OPENAI_API_KEY;
  const originalOpenaiBaseUrl = process.env.OPENAI_BASE_URL;
  const originalProvider = process.env.MCPMAKE_LLM_PROVIDER;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.MCPMAKE_LLM_PROVIDER;
  });

  afterEach(() => {
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
    if (originalOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenaiKey;
    if (originalOpenaiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalOpenaiBaseUrl;
    if (originalProvider === undefined) delete process.env.MCPMAKE_LLM_PROVIDER;
    else process.env.MCPMAKE_LLM_PROVIDER = originalProvider;
  });

  describe('resolveProviderKind', () => {
    it('defaults to anthropic when MCPMAKE_LLM_PROVIDER is unset', () => {
      expect(resolveProviderKind()).toBe('anthropic');
    });

    it('returns openai when set to openai', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai';
      expect(resolveProviderKind()).toBe('openai');
    });

    it('returns openai-compatible when set to openai-compatible', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      expect(resolveProviderKind()).toBe('openai-compatible');
    });

    it('is case-insensitive', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'OpenAI';
      expect(resolveProviderKind()).toBe('openai');
    });

    it('falls back to anthropic for an unknown value', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'gemini';
      expect(resolveProviderKind()).toBe('anthropic');
    });
  });

  describe('getLlmProvider', () => {
    it('returns null for anthropic when ANTHROPIC_API_KEY is unset', () => {
      expect(getLlmProvider()).toBeNull();
    });

    it('returns an anthropic provider when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const provider = getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('anthropic');
    });

    it('returns null under openai without OPENAI_API_KEY', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai';
      expect(getLlmProvider()).toBeNull();
    });

    it('returns an openai provider when OPENAI_API_KEY is set', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      const provider = getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('openai');
    });

    it('returns null under openai-compatible when OPENAI_BASE_URL is unset, even with a key', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      expect(getLlmProvider()).toBeNull();
    });

    it('returns an openai-compatible provider with a base url and no key', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
      const provider = getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('openai-compatible');
    });
  });

  describe('requireLlmProvider', () => {
    it('returns the provider when one is available', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const provider = requireLlmProvider('spec generation');
      expect(provider.name).toBe('anthropic');
    });

    it('throws mentioning ANTHROPIC_API_KEY under default anthropic with no key', () => {
      expect(() => requireLlmProvider('spec generation')).toThrow(/ANTHROPIC_API_KEY/);
    });

    it('throws mentioning OPENAI_API_KEY under openai with no key', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai';
      expect(() => requireLlmProvider('spec generation')).toThrow(/OPENAI_API_KEY/);
    });

    it('throws mentioning OPENAI_BASE_URL under openai-compatible with no base url', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      expect(() => requireLlmProvider('spec generation')).toThrow(/OPENAI_BASE_URL/);
    });
  });
});
