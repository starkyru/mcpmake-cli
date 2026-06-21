import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock DNS so the DNS-aware base-URL guard can be exercised without real network
// resolution. `vi.mock` is hoisted; the factory installs a controllable `lookup`.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

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
    lookupMock.mockReset();
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
    it('returns null for anthropic when ANTHROPIC_API_KEY is unset', async () => {
      expect(await getLlmProvider()).toBeNull();
    });

    it('returns an anthropic provider when ANTHROPIC_API_KEY is set', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const provider = await getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('anthropic');
    });

    it('returns null under openai without OPENAI_API_KEY', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai';
      expect(await getLlmProvider()).toBeNull();
    });

    it('returns an openai provider when OPENAI_API_KEY is set', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      const provider = await getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('openai');
    });

    it('returns null under openai-compatible when OPENAI_BASE_URL is unset, even with a key', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      expect(await getLlmProvider()).toBeNull();
    });

    it('returns an openai-compatible provider with a base url and no key', async () => {
      // Documented Ollama flow points at localhost — operator opts in via the
      // existing private-hosts escape hatch.
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
      process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
      const provider = await getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('openai-compatible');
    });
  });

  describe('base-URL SSRF guard', () => {
    it('rejects a private OPENAI_BASE_URL without MCPMAKE_ALLOW_PRIVATE_HOSTS', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';
      await expect(getLlmProvider()).rejects.toThrow(/MCPMAKE_ALLOW_PRIVATE_HOSTS/);
    });

    it('accepts a private OPENAI_BASE_URL when MCPMAKE_ALLOW_PRIVATE_HOSTS is set', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';
      process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
      const provider = await getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('openai-compatible');
    });

    it('rejects a private ANTHROPIC_BASE_URL without the escape hatch', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.ANTHROPIC_BASE_URL = 'http://169.254.169.254/';
      await expect(getLlmProvider()).rejects.toThrow(/private\/loopback/);
    });

    it('rejects a localhost hostname (not just a literal IP) without the escape hatch', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
      await expect(getLlmProvider()).rejects.toThrow(/MCPMAKE_ALLOW_PRIVATE_HOSTS/);
    });

    it('rejects a non-http(s) base URL', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.ANTHROPIC_BASE_URL = 'file:///etc/passwd';
      await expect(getLlmProvider()).rejects.toThrow(/http\(s\)/);
    });

    it('accepts a public base URL', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
      lookupMock.mockResolvedValue([{ address: '160.79.104.10', family: 4 }]);
      const provider = await getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('anthropic');
    });

    it('is a no-op when no base URL is set (default anthropic flow)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const provider = await getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('anthropic');
      expect(lookupMock).not.toHaveBeenCalled();
    });
  });

  describe('base-URL SSRF guard — DNS-aware (A3-M2)', () => {
    it('rejects a hostname that resolves to a private address (e.g. localtest.me → 127.0.0.1)', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://localtest.me:11434/v1';
      lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(getLlmProvider()).rejects.toThrow(
        /resolves to private\/reserved address 127\.0\.0\.1/,
      );
      expect(lookupMock).toHaveBeenCalledWith('localtest.me', { all: true });
    });

    it('rejects when ANY resolved address is private (mixed public + private)', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://rebind.example:11434/v1';
      lookupMock.mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
      await expect(getLlmProvider()).rejects.toThrow(/private\/reserved address 10\.0\.0\.5/);
    });

    it('accepts a hostname that resolves only to public addresses', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      process.env.OPENAI_BASE_URL = 'http://api.example.com/v1';
      lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const provider = await getLlmProvider();
      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('openai');
    });

    it('refuses to send credentials when DNS resolution fails', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      process.env.OPENAI_BASE_URL = 'http://does-not-resolve.invalid/v1';
      lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(getLlmProvider()).rejects.toThrow(/could not be resolved/);
    });

    it('skips DNS entirely when MCPMAKE_ALLOW_PRIVATE_HOSTS is set', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      process.env.OPENAI_BASE_URL = 'http://localtest.me:11434/v1';
      process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
      const provider = await getLlmProvider();
      expect(provider).not.toBeNull();
      expect(lookupMock).not.toHaveBeenCalled();
    });
  });

  describe('requireLlmProvider', () => {
    it('returns the provider when one is available', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const provider = await requireLlmProvider('spec generation');
      expect(provider.name).toBe('anthropic');
    });

    it('throws mentioning ANTHROPIC_API_KEY under default anthropic with no key', async () => {
      await expect(requireLlmProvider('spec generation')).rejects.toThrow(/ANTHROPIC_API_KEY/);
    });

    it('throws mentioning OPENAI_API_KEY under openai with no key', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai';
      await expect(requireLlmProvider('spec generation')).rejects.toThrow(/OPENAI_API_KEY/);
    });

    it('throws mentioning OPENAI_BASE_URL under openai-compatible with no base url', async () => {
      process.env.MCPMAKE_LLM_PROVIDER = 'openai-compatible';
      await expect(requireLlmProvider('spec generation')).rejects.toThrow(/OPENAI_BASE_URL/);
    });
  });
});
