import { describe, it, expect } from 'vitest';
import { collectLowConfidenceSelectors, summarizeRescan } from '../../src/rescan/rescan-runner.js';
import type {
  SiteDescriptor,
  SelectorSet,
  RescanResult,
  SiteChangeEntry,
} from '../../src/types/site.js';

function sel(primary: string, confidence: number): SelectorSet {
  return { primary, fallbacks: [], strategy: 'css-path', confidence };
}

function makeSite(): SiteDescriptor {
  return {
    siteId: 'site_test',
    baseUrl: 'https://example.com',
    analyzedAt: '2026-06-18T00:00:00.000Z',
    version: 3,
    crawlDepth: 2,
    metadata: {},
    pages: [
      {
        pageId: 'page_1',
        url: 'https://example.com/login',
        analyzedAt: '2026-06-18T00:00:00.000Z',
        forms: [
          {
            formId: 'form_1',
            method: 'post',
            semanticName: 'login_form',
            selector: sel('form.login', 0.3), // low
            submitButton: sel('button#go', 0.2), // low
            fields: [
              { name: 'email', fieldType: 'text', required: true, selector: sel('#email', 0.9) }, // high
              {
                name: 'pw',
                fieldType: 'password',
                required: true,
                selector: sel('//input[2]', 0.2),
              }, // low
            ],
          },
        ],
        buttons: [
          { buttonId: 'btn_1', type: 'button', text: 'Help', selector: sel('#help', 0.95) }, // high
          { buttonId: 'btn_2', type: 'button', text: 'Menu', selector: sel('div>span', 0.4) }, // low
        ],
        links: [
          {
            linkId: 'lnk_1',
            href: 'https://example.com/about',
            isNavigation: true,
            selector: sel('a.brittle', 0.3), // low
          },
        ],
      },
    ],
  };
}

describe('collectLowConfidenceSelectors', () => {
  it('collects exactly the selectors below the threshold', () => {
    const site = makeSite();
    const lows = collectLowConfidenceSelectors(site, 0.5);
    // form(0.3), submit(0.2), pw field(0.2), menu button(0.4), link(0.3) = 5
    expect(lows).toHaveLength(5);
    const primaries = lows.map((l) => l.selector.primary).sort();
    expect(primaries).toEqual(
      ['//input[2]', 'a.brittle', 'button#go', 'div>span', 'form.login'].sort(),
    );
    // high-confidence selectors are excluded
    expect(primaries).not.toContain('#email');
    expect(primaries).not.toContain('#help');
  });

  it('returns live object references so healing mutates the descriptor', () => {
    const site = makeSite();
    const lows = collectLowConfidenceSelectors(site, 0.5);
    const linkLow = lows.find((l) => l.selector.primary === 'a.brittle')!;
    Object.assign(linkLow.selector, { primary: '[data-testid="about"]', confidence: 0.95 });
    // mutation is visible through the descriptor
    expect(site.pages[0].links[0].selector.primary).toBe('[data-testid="about"]');
    expect(site.pages[0].links[0].selector.confidence).toBe(0.95);
  });

  it('attaches a useful page URL and description to each entry', () => {
    const lows = collectLowConfidenceSelectors(makeSite(), 0.5);
    for (const low of lows) {
      expect(low.pageUrl).toBe('https://example.com/login');
      expect(low.description.length).toBeGreaterThan(0);
    }
    expect(lows.some((l) => l.description.includes('login_form'))).toBe(true);
  });
});

describe('summarizeRescan', () => {
  it('counts changes by type and element, and surfaces broken selectors', () => {
    const ts = '2026-06-18T00:00:00.000Z';
    const ch = (
      changeType: SiteChangeEntry['changeType'],
      elementType: SiteChangeEntry['elementType'],
    ): SiteChangeEntry => ({
      changeType,
      elementType,
      elementId: 'x',
      pageId: 'page_1',
      description: 'd',
      timestamp: ts,
    });

    const result: RescanResult = {
      previousVersion: 3,
      newVersion: 4,
      timestamp: ts,
      changes: [
        ch('added', 'page'),
        ch('added', 'form'),
        ch('removed', 'button'),
        ch('modified', 'field'),
        ch('modified', 'link'),
        ch('selector-broken', 'form'), // counted via brokenSelectors, not modified
      ],
      brokenSelectors: [{ toolName: 'login_form', selector: sel('form.login', 0.3) }],
      newSiteDescriptor: makeSite(),
    };

    const summary = summarizeRescan(result);
    expect(summary.previousVersion).toBe(3);
    expect(summary.newVersion).toBe(4);
    expect(summary.added).toEqual({ page: 1, form: 1, field: 0, button: 0, link: 0 });
    expect(summary.removed).toEqual({ page: 0, form: 0, field: 0, button: 1, link: 0 });
    expect(summary.modified).toEqual({ page: 0, form: 0, field: 1, button: 0, link: 1 });
    expect(summary.brokenSelectors).toBe(1);
    expect(summary.totalChanges).toBe(6);
  });
});
