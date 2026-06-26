import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SelectorSet } from '../../src/types/site.js';

// Per-test control over the raw model text returned by the SDK.
const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}));

// Bypass the live Models API — we only care about response parsing here.
vi.mock('../../src/utils/model-resolver.js', () => ({
  resolveModel: vi.fn().mockResolvedValue('claude-haiku-test'),
}));

function modelReturns(text: string) {
  createMock.mockResolvedValueOnce({ content: [{ type: 'text', text }] });
}

const broken: SelectorSet = {
  primary: '#old-login',
  fallbacks: [],
  strategy: 'id',
  confidence: 0.4,
  humanLabel: 'Login button',
};

const validSelectorJson = JSON.stringify({
  primary: 'button.login',
  fallbacks: ['#login'],
  strategy: 'css-path',
  confidence: 0.9,
  humanLabel: 'Login button',
});

describe('selector-healer (L-jsonparse: tolerates fenced/prose output)', () => {
  beforeEach(() => {
    createMock.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('parses a bare JSON object', async () => {
    modelReturns(validSelectorJson);
    const { healBrokenSelector } = await import('../../src/site-transformer/selector-healer.js');
    const result = await healBrokenSelector('tree', broken, 'the login button');
    expect(result?.primary).toBe('button.login');
  });

  it('parses a ```json-fenced object', async () => {
    modelReturns('```json\n' + validSelectorJson + '\n```');
    const { healBrokenSelector } = await import('../../src/site-transformer/selector-healer.js');
    const result = await healBrokenSelector('tree', broken, 'the login button');
    expect(result?.primary).toBe('button.login');
  });

  it('parses an object wrapped in prose', async () => {
    modelReturns('Here is the new selector:\n' + validSelectorJson + '\nDone.');
    const { healBrokenSelector } = await import('../../src/site-transformer/selector-healer.js');
    const result = await healBrokenSelector('tree', broken, 'the login button');
    expect(result?.primary).toBe('button.login');
  });

  it('returns null on a literal null response', async () => {
    modelReturns('null');
    const { healBrokenSelector } = await import('../../src/site-transformer/selector-healer.js');
    expect(await healBrokenSelector('tree', broken, 'x')).toBeNull();
  });

  it('returns null on unparseable (no JSON object) output', async () => {
    modelReturns('I could not find a matching element on the page.');
    const { healBrokenSelector } = await import('../../src/site-transformer/selector-healer.js');
    expect(await healBrokenSelector('tree', broken, 'x')).toBeNull();
  });

  it('(A4-11b) strips control chars from humanLabel before returning', async () => {
    const withCtrl = JSON.stringify({
      primary: 'button.login',
      fallbacks: [],
      strategy: 'css-path',
      confidence: 0.9,
      humanLabel: 'Login\x00button\x1f',
    });
    modelReturns(withCtrl);
    const { healBrokenSelector } = await import('../../src/site-transformer/selector-healer.js');
    const result = await healBrokenSelector('tree', broken, 'login button');
    expect(result).not.toBeNull();
    // Control chars replaced with space and trimmed.
    expect(result?.humanLabel).toBe('Login button');
  });

  it('(A4-11b) rejects a humanLabel that exceeds 200 characters', async () => {
    const longLabel = JSON.stringify({
      primary: 'button.login',
      fallbacks: [],
      strategy: 'css-path',
      confidence: 0.9,
      humanLabel: 'x'.repeat(201),
    });
    modelReturns(longLabel);
    const { healBrokenSelector } = await import('../../src/site-transformer/selector-healer.js');
    const result = await healBrokenSelector('tree', broken, 'login button');
    expect(result).toBeNull();
  });

  it('normalizes a missing/non-array fallbacks key to an empty string[]', async () => {
    // The LLM OMITS `fallbacks` entirely (otherwise-valid object). Before the
    // fix the returned `fallbacks` was `undefined`, so a downstream consumer
    // doing `[primary, ...fallbacks]` threw "is not iterable".
    const noFallbacks = JSON.stringify({
      primary: 'button.login',
      strategy: 'css-path',
      confidence: 0.9,
      humanLabel: 'Login button',
    });
    modelReturns(noFallbacks);
    const { healBrokenSelector } = await import('../../src/site-transformer/selector-healer.js');
    const result = await healBrokenSelector('tree', broken, 'login button');
    expect(result).not.toBeNull();
    expect(Array.isArray(result?.fallbacks)).toBe(true);
    expect(result?.fallbacks).toEqual([]);

    // A non-array `fallbacks` (here: a string) is normalized to [] as well.
    const stringFallbacks = JSON.stringify({
      primary: 'button.login',
      fallbacks: 'not-an-array',
      strategy: 'css-path',
      confidence: 0.9,
      humanLabel: 'Login button',
    });
    modelReturns(stringFallbacks);
    const result2 = await healBrokenSelector('tree', broken, 'login button');
    expect(result2).not.toBeNull();
    expect(Array.isArray(result2?.fallbacks)).toBe(true);
    expect(result2?.fallbacks).toEqual([]);
  });
});
