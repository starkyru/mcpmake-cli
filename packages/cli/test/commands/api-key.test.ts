import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyApiKey } from '../../src/commands/api-key.js';

describe('applyApiKey', () => {
  const original = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
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
});
