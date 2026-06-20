import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PageDescriptor } from '../../src/types/site.js';

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}));

vi.mock('../../src/utils/model-resolver.js', () => ({
  resolveModel: vi.fn().mockResolvedValue('claude-haiku-test'),
}));

function modelReturns(text: string) {
  createMock.mockResolvedValueOnce({ content: [{ type: 'text', text }] });
}

function makePage(): PageDescriptor {
  return {
    pageId: 'p0',
    url: 'https://example.com/login',
    forms: [],
    buttons: [],
    links: [],
    analyzedAt: new Date().toISOString(),
  };
}

const resultJson = JSON.stringify({
  pages: [
    {
      pageIndex: 0,
      semanticName: 'login_page',
      description: 'The login page',
      forms: [],
      buttons: [],
      links: [],
    },
  ],
});

describe('semantic-analyzer (L-jsonparse: tolerates fenced/prose output)', () => {
  beforeEach(() => {
    createMock.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('applies semantics from a ```json-fenced response', async () => {
    modelReturns('```json\n' + resultJson + '\n```');
    const { analyzeSemantics } = await import('../../src/analyzer/semantic-analyzer.js');
    const out = await analyzeSemantics([makePage()]);
    expect(out[0].semanticName).toBe('login_page');
  });

  it('applies semantics from a prose-wrapped response', async () => {
    modelReturns('Sure, here is the analysis:\n' + resultJson + '\nLet me know!');
    const { analyzeSemantics } = await import('../../src/analyzer/semantic-analyzer.js');
    const out = await analyzeSemantics([makePage()]);
    expect(out[0].semanticName).toBe('login_page');
  });

  it('returns pages unchanged when no JSON object can be extracted', async () => {
    modelReturns('I was unable to analyze the provided pages.');
    const { analyzeSemantics } = await import('../../src/analyzer/semantic-analyzer.js');
    const page = makePage();
    const out = await analyzeSemantics([page]);
    expect(out[0].semanticName).toBeUndefined();
  });

  it('returns pages unchanged on truncated/unbalanced JSON', async () => {
    modelReturns('{"pages": [');
    const { analyzeSemantics } = await import('../../src/analyzer/semantic-analyzer.js');
    const out = await analyzeSemantics([makePage()]);
    expect(out[0].semanticName).toBeUndefined();
  });
});
