import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLlmProvider, requireLlmProvider, resolveProviderKind } from '../../src/llm/index.js';

describe('provider selection', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalOpenaiKey = process.env.OPENAI_API_KEY;
  const originalOpenaiBaseUrl = process.env.OPENAI_BASE_URL;
  const originalProvider = process.env.MCPMAKE_LLM_PROVIDER;
  const originalAllowPrivate = process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.MCPMAKE_LLM_PROVIDER;
    delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
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
    if (originalAllowPrivate === undefined) delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
    else process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = originalAllowPrivate;
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
      // Documented Ollama flow points at localhost — operator opts in via the
      // existing private-hosts escape hatch.
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
      process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
      const provider = getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('openai-compatible');
    });
  });

  describe('base-URL SSRF guard', () => {
    it('rejects a private OPENAI_BASE_URL without MCPMAKE_ALLOW_PRIVATE_HOSTS', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';
      expect(() => getLlmProvider()).toThrow(/MCPMAKE_ALLOW_PRIVATE_HOSTS/);
    });

    it('accepts a private OPENAI_BASE_URL when MCPMAKE_ALLOW_PRIVATE_HOSTS is set', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';
      process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
      const provider = getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('openai-compatible');
    });

    it('rejects a private ANTHROPIC_BASE_URL without the escape hatch', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.ANTHROPIC_BASE_URL = 'http://169.254.169.254/';
      expect(() => getLlmProvider()).toThrow(/private\/loopback/);
    });

    it('rejects a localhost hostname (not just a literal IP) without the escape hatch', () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
      expect(() => getLlmProvider()).toThrow(/MCPMAKE_ALLOW_PRIVATE_HOSTS/);
    });

    it('rejects a non-http(s) base URL', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.ANTHROPIC_BASE_URL = 'file:///etc/passwd';
      expect(() => getLlmProvider()).toThrow(/http\(s\)/);
    });

    it('accepts a public base URL', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
      const provider = getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('anthropic');
    });

    it('is a no-op when no base URL is set (default anthropic flow)', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const provider = getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('anthropic');
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
