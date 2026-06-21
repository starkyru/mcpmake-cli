import { describe, it, expect } from 'vitest';
import { diffSiteDescriptors } from '../../src/rescan/diff-engine.js';
import type { SiteDescriptor, SelectorSet } from '../../src/types/site.js';

function sel(primary: string, confidence: number): SelectorSet {
  return { primary, fallbacks: [], strategy: 'css-path', confidence };
}

function baseSite(overrides?: Partial<SiteDescriptor>): SiteDescriptor {
  return {
    siteId: 'site_1',
    baseUrl: 'https://example.com',
    analyzedAt: '2026-06-20T00:00:00.000Z',
    version: 1,
    crawlDepth: 2,
    metadata: {},
    pages: [],
    ...overrides,
  };
}

function pageWith(forms: unknown[] = [], buttons: unknown[] = [], links: unknown[] = []) {
  return {
    pageId: 'page_1',
    url: 'https://example.com/',
    analyzedAt: '2026-06-20T00:00:00.000Z',
    forms,
    buttons,
    links,
  };
}

// ─── Malformed-element guard tests ──────────────────────────────────────────

describe('diffSiteDescriptors — malformed form elements', () => {
  it('does not throw when a form is missing selector (form: {})', () => {
    // A live-crawled page whose forms array contains a bare {} object.
    const page = pageWith([{}]);
    const old = baseSite({ pages: [page] as SiteDescriptor['pages'] });
    const next = baseSite({ pages: [page] as SiteDescriptor['pages'] });

    expect(() => diffSiteDescriptors(old, next)).not.toThrow();
  });

  it('does not throw when both old and new have a malformed form and skips selector diff', () => {
    const malformedForm = {} as unknown;
    const old = baseSite({
      pages: [pageWith([malformedForm])] as SiteDescriptor['pages'],
    });
    const next = baseSite({
      pages: [pageWith([malformedForm])] as SiteDescriptor['pages'],
    });

    const result = diffSiteDescriptors(old, next);
    // No selector-broken or modified entries should be emitted for the malformed form.
    const selectorEvents = result.changes.filter(
      (c) =>
        c.elementType === 'form' &&
        (c.changeType === 'selector-broken' || c.changeType === 'modified'),
    );
    expect(selectorEvents).toHaveLength(0);
    expect(result.brokenSelectors).toHaveLength(0);
  });

  it('does not throw when a button is missing selector', () => {
    const malformedButton = { buttonId: 'btn_bad', type: 'button' } as unknown;
    const page = pageWith([], [malformedButton]);
    const old = baseSite({ pages: [page] as SiteDescriptor['pages'] });
    const next = baseSite({ pages: [page] as SiteDescriptor['pages'] });

    expect(() => diffSiteDescriptors(old, next)).not.toThrow();
  });

  it('does not throw when a link is missing selector', () => {
    const malformedLink = { linkId: 'lnk_bad', href: '/about', isNavigation: true } as unknown;
    const page = pageWith([], [], [malformedLink]);
    const old = baseSite({ pages: [page] as SiteDescriptor['pages'] });
    const next = baseSite({ pages: [page] as SiteDescriptor['pages'] });

    expect(() => diffSiteDescriptors(old, next)).not.toThrow();
  });

  it('still diffs well-formed forms alongside malformed ones correctly', () => {
    const goodForm = {
      formId: 'form_good',
      method: 'post',
      selector: sel('form.login', 0.9),
      fields: [],
    };
    const oldSelector = sel('form.login', 0.9);
    const newSelector = sel('form.login-v2', 0.8);
    const goodFormModified = { ...goodForm, selector: newSelector };

    const old = baseSite({
      pages: [
        pageWith([{} as unknown, { ...goodForm, selector: oldSelector }]),
      ] as SiteDescriptor['pages'],
    });
    const next = baseSite({
      pages: [pageWith([{} as unknown, goodFormModified])] as SiteDescriptor['pages'],
    });

    const result = diffSiteDescriptors(old, next);
    // The well-formed form selector change is detected.
    const modified = result.changes.filter(
      (c) => c.elementType === 'form' && c.changeType === 'modified',
    );
    expect(modified).toHaveLength(1);
    expect(modified[0].elementId).toBe('form_good');
    expect(modified[0].oldValue).toBe('form.login');
    expect(modified[0].newValue).toBe('form.login-v2');
  });

  it('still detects form field additions on forms missing a selector', () => {
    // diffFormFields runs before the selector guard — it should still be called.
    const formWithFields = {
      formId: 'form_noss',
      method: 'post',
      // No selector — malformed.
      fields: [{ name: 'email', fieldType: 'text', required: true, selector: sel('#e', 0.9) }],
    };
    const formWithExtraField = {
      ...formWithFields,
      fields: [
        ...formWithFields.fields,
        { name: 'phone', fieldType: 'text', required: false, selector: sel('#p', 0.9) },
      ],
    };

    const old = baseSite({
      pages: [pageWith([formWithFields])] as SiteDescriptor['pages'],
    });
    const next = baseSite({
      pages: [pageWith([formWithExtraField])] as SiteDescriptor['pages'],
    });

    const result = diffSiteDescriptors(old, next);
    const fieldAdded = result.changes.filter(
      (c) => c.elementType === 'field' && c.changeType === 'added',
    );
    expect(fieldAdded).toHaveLength(1);
    expect(fieldAdded[0].newValue).toBe('phone');
  });
});

// ─── Normal-path regression tests ───────────────────────────────────────────

describe('diffSiteDescriptors — well-formed descriptors', () => {
  it('returns empty changes when old and new are identical', () => {
    const page = pageWith(
      [
        {
          formId: 'form_1',
          method: 'post',
          selector: sel('form', 0.9),
          fields: [],
        },
      ],
      [{ buttonId: 'btn_1', type: 'button', selector: sel('#btn', 0.9) }],
      [{ linkId: 'lnk_1', href: '/about', isNavigation: true, selector: sel('a', 0.9) }],
    );
    const old = baseSite({ pages: [page] as SiteDescriptor['pages'] });
    const next = baseSite({ pages: [page] as SiteDescriptor['pages'] });

    const result = diffSiteDescriptors(old, next);
    expect(result.changes).toHaveLength(0);
    expect(result.brokenSelectors).toHaveLength(0);
  });

  it('emits selector-broken when form selector confidence drops below 0.5', () => {
    const formId = 'form_1';
    const old = baseSite({
      pages: [
        pageWith([
          {
            formId,
            method: 'post',
            selector: sel('form.login', 0.9),
            fields: [],
          },
        ]),
      ] as SiteDescriptor['pages'],
    });
    const next = baseSite({
      pages: [
        pageWith([
          {
            formId,
            method: 'post',
            selector: sel('form:nth-child(2)', 0.2),
            fields: [],
          },
        ]),
      ] as SiteDescriptor['pages'],
    });

    const result = diffSiteDescriptors(old, next);
    expect(result.brokenSelectors).toHaveLength(1);
    expect(result.brokenSelectors[0].selector.primary).toBe('form.login');
    const broken = result.changes.find((c) => c.changeType === 'selector-broken');
    expect(broken).toBeDefined();
    expect(broken?.elementId).toBe(formId);
  });

  it('detects added and removed pages', () => {
    const old = baseSite({
      pages: [
        {
          pageId: 'page_home',
          url: 'https://example.com/',
          analyzedAt: '2026-06-20T00:00:00.000Z',
          forms: [],
          buttons: [],
          links: [],
        },
      ],
    });
    const next = baseSite({
      pages: [
        {
          pageId: 'page_about',
          url: 'https://example.com/about',
          analyzedAt: '2026-06-20T00:00:00.000Z',
          forms: [],
          buttons: [],
          links: [],
        },
      ],
    });

    const result = diffSiteDescriptors(old, next);
    expect(result.changes.some((c) => c.changeType === 'added' && c.elementType === 'page')).toBe(
      true,
    );
    expect(result.changes.some((c) => c.changeType === 'removed' && c.elementType === 'page')).toBe(
      true,
    );
  });

  it('increments version', () => {
    const old = baseSite({ version: 5 });
    const next = baseSite({ version: 5 });

    const result = diffSiteDescriptors(old, next);
    expect(result.previousVersion).toBe(5);
    expect(result.newVersion).toBe(6);
    expect(result.newSiteDescriptor.version).toBe(6);
  });
});
