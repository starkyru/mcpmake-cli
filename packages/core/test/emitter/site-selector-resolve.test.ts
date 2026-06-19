import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSiteTemplate } from '../../src/emitter/site-template-loader.js';

const here = dirname(fileURLToPath(import.meta.url));

// Render the generated browser-manager to a temp module under the repo (so
// vitest's transform pipeline compiles it) and import it to exercise the real
// resolveSelector runtime logic against a mock Playwright Page.
const tmpFile = join(here, `__browser_manager_runtime_${process.pid}.ts`);
/* eslint-disable @typescript-eslint/no-explicit-any */
let bm: any;

beforeAll(async () => {
  writeFileSync(tmpFile, renderSiteTemplate('browser-manager.ts', {}));
  bm = await import(/* @vite-ignore */ tmpFile);
});

afterAll(() => {
  rmSync(tmpFile, { force: true });
});

/** Mock page where a selector "exists" if it's in `present` (fast path via $). */
function makePage(present: string[], throwOn: string[] = []) {
  const set = new Set(present);
  const bad = new Set(throwOn);
  return {
    async $(sel: string) {
      if (bad.has(sel)) throw new Error('invalid selector');
      return set.has(sel) ? { dispose: async () => {} } : null;
    },
    async waitForSelector(sel: string) {
      if (set.has(sel)) return {};
      throw new Error('timeout');
    },
  };
}

/** Mock page where `$` never finds anything, forcing the slow waitForSelector path. */
function makeSlowPage(present: string[]) {
  const set = new Set(present);
  return {
    async $() {
      return null;
    },
    async waitForSelector(sel: string) {
      if (set.has(sel)) return {};
      throw new Error('timeout');
    },
  };
}

describe('generated browser-manager — resolveSelector', () => {
  it('returns the primary selector when it is present', async () => {
    const page = makePage(['#email', 'input[name="email"]']);
    await expect(bm.resolveSelector(page, ['#email', 'input[name="email"]'])).resolves.toBe(
      '#email',
    );
  });

  it('falls back to the next selector when the primary is missing', async () => {
    const page = makePage(['input[name="email"]']);
    await expect(
      bm.resolveSelector(page, ['#email', 'input[name="email"]', 'input[type="email"]']),
    ).resolves.toBe('input[name="email"]');
  });

  it('skips a syntactically invalid selector and uses a working fallback', async () => {
    const page = makePage(['.good'], ['::bogus']);
    await expect(bm.resolveSelector(page, ['::bogus', '.good'])).resolves.toBe('.good');
  });

  it('throws a descriptive error when no candidate resolves', async () => {
    const page = makePage([]);
    await expect(bm.resolveSelector(page, ['#a', '#b'], { timeoutMs: 20 })).rejects.toThrow(
      /None of the selectors resolved/,
    );
  });

  it('throws when no candidates are provided', async () => {
    const page = makePage([]);
    await expect(bm.resolveSelector(page, [])).rejects.toThrow(/No selector candidates/);
  });

  it('ignores undefined/empty candidates', async () => {
    const page = makePage(['#real']);
    await expect(bm.resolveSelector(page, [undefined, '', '   ', '#real'])).resolves.toBe('#real');
  });

  it('uses the slow waitForSelector path for late-rendered elements', async () => {
    const page = makeSlowPage(['#b']);
    await expect(bm.resolveSelector(page, ['#a', '#b'], { timeoutMs: 50 })).resolves.toBe('#b');
  });
});

describe('generated handlers wire resolveSelector with fallbacks', () => {
  const formTool = {
    name: 'login',
    title: 'Login',
    description: 'Log in',
    inputSchemaCode: '{ email: z.string(), remember: z.boolean().optional() }',
    pageUrl: 'https://example.com/login',
    form: {
      fields: [
        {
          name: 'email',
          fieldType: 'text',
          selector: {
            primary: '#email',
            fallbacks: ['input[name="email"]', 'input[type="email"]'],
          },
        },
        {
          name: 'remember',
          fieldType: 'checkbox',
          selector: { primary: '#remember', fallbacks: ['input[name="remember"]'] },
        },
      ],
      submitButton: { primary: '#submit', fallbacks: ['button[type="submit"]'] },
    },
  };

  const buttonTool = {
    name: 'add_to_cart',
    title: 'Add to cart',
    description: 'Add item to cart',
    inputSchemaCode: '{}',
    button: { selector: { primary: '#add', fallbacks: ['button.add-to-cart'] } },
  };

  it('form handler resolves field selectors with their fallbacks', () => {
    const out = renderSiteTemplate('tool-handler-form.ts', formTool);
    expect(out).toContain('import { getOrCreateSession, takeScreenshot, resolveSelector }');
    // text field: primary + both fallbacks in the candidate list, then fill via resolved selector
    expect(out).toContain(
      "resolveSelector(page, ['#email', 'input[name=\"email\"]', 'input[type=\"email\"]'])",
    );
    expect(out).toContain('await page.fill(fieldSelector,');
    // checkbox field
    expect(out).toContain("resolveSelector(page, ['#remember', 'input[name=\"remember\"]'])");
    expect(out).toContain('await page.check(fieldSelector)');
    // submit button
    expect(out).toContain("resolveSelector(page, ['#submit', 'button[type=\"submit\"]'])");
    expect(out).toContain('await page.click(submitSelector)');
    // the brittle direct-primary calls are gone
    expect(out).not.toContain("await page.fill('#email'");
    expect(out).not.toContain("await page.click('#submit')");
  });

  it('action handler resolves the button selector with its fallbacks', () => {
    const out = renderSiteTemplate('tool-handler-action.ts', buttonTool);
    expect(out).toContain('import { getOrCreateSession, takeScreenshot, resolveSelector }');
    expect(out).toContain("resolveSelector(page, ['#add', 'button.add-to-cart'])");
    expect(out).toContain('await page.click(buttonSelector)');
    expect(out).not.toContain("await page.click('#add')");
  });
});
