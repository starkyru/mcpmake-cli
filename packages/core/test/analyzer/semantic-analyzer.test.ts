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

  it('(A4-11a) returns pages unchanged when pages is null instead of an array', async () => {
    modelReturns(JSON.stringify({ pages: null }));
    const { analyzeSemantics } = await import('../../src/analyzer/semantic-analyzer.js');
    const out = await analyzeSemantics([makePage()]);
    expect(out[0].semanticName).toBeUndefined();
  });

  it('(A4-11a) returns pages unchanged when result has no pages key', async () => {
    modelReturns(JSON.stringify({ result: [] }));
    const { analyzeSemantics } = await import('../../src/analyzer/semantic-analyzer.js');
    const out = await analyzeSemantics([makePage()]);
    expect(out[0].semanticName).toBeUndefined();
  });

  it('keeps page semantics when the LLM omits the buttons key for a page that HAS a button', async () => {
    // Real crawled page WITH a non-empty button: the enrichment `.map` callback
    // must run to reach the per-element `.find`, which is where the omitted-key
    // crash used to surface and discard ALL semantic naming for the whole site.
    const page = makePage();
    page.buttons = [
      {
        buttonId: 'b0',
        selector: { primary: '#cart', fallbacks: [], strategy: 'id', confidence: 1 },
        text: 'Add to cart',
        type: 'button',
      },
    ];

    // LLM result provides page semanticName/description (and a forms key) but
    // OMITS `buttons` entirely — exactly what LLMs do for arrays they consider
    // empty/irrelevant. Pre-fix, `pageResult.buttons.find` threw here.
    modelReturns(
      JSON.stringify({
        pages: [
          {
            pageIndex: 0,
            semanticName: 'cart_page',
            description: 'The shopping cart page',
            forms: [],
            // no `buttons` key, no `links` key
          },
        ],
      }),
    );

    const { analyzeSemantics } = await import('../../src/analyzer/semantic-analyzer.js');
    const out = await analyzeSemantics([page]);

    // Enrichment was NOT discarded: the page semantics the LLM DID provide are applied.
    expect(out[0].semanticName).toBe('cart_page');
    expect(out[0].description).toBe('The shopping cart page');

    // The button whose result was omitted is returned unchanged (graceful
    // per-element fallback, not a thrown-away site).
    expect(out[0].buttons).toHaveLength(1);
    expect(out[0].buttons[0].buttonId).toBe('b0');
    expect(out[0].buttons[0].text).toBe('Add to cart');
    expect(out[0].buttons[0].semanticAction).toBeUndefined();
  });
});
