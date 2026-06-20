import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { renderSiteTemplate } from '../../src/emitter/site-template-loader.js';

/** Transpile a rendered template and fail on any syntactic diagnostic. */
function assertParses(source: string, label: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const syntactic = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (syntactic.length > 0) {
    const msgs = syntactic
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('; ');
    throw new Error(`${label} did not parse: ${msgs}`);
  }
  expect(syntactic).toHaveLength(0);
}

const sel = (primary: string, fallbacks: string[] = []) => ({
  primary,
  fallbacks,
  strategy: 'id' as const,
  confidence: 0.9,
});

describe('generated site handlers parse as valid TypeScript', () => {
  it('form handler with every field type + submit button', () => {
    const tool = {
      name: 'signup',
      title: 'Sign up',
      description: 'Create an account',
      inputSchemaCode:
        '{ email: z.string(), agree: z.boolean(), plan: z.string(), tier: z.string() }',
      pageUrl: 'https://example.com/signup?ref=1',
      form: {
        fields: [
          {
            name: 'email',
            inputKey: 'email',
            fieldType: 'text',
            selector: sel('#email', ['input[name="email"]']),
          },
          { name: 'agree', inputKey: 'agree', fieldType: 'checkbox', selector: sel('#agree') },
          {
            name: 'plan',
            inputKey: 'plan',
            fieldType: 'select',
            selector: sel('#plan', ['select[name="plan"]']),
          },
          { name: 'tier', inputKey: 'tier', fieldType: 'radio', selector: sel('#tier') },
          { name: 'csrf', inputKey: 'csrf', fieldType: 'hidden', selector: sel('#csrf') },
        ],
        submitButton: sel('#submit', ['button[type="submit"]']),
      },
    };
    assertParses(renderSiteTemplate('tool-handler-form.ts', tool), 'form+submit');
  });

  it('form handler without a submit button', () => {
    const tool = {
      name: 'search',
      title: 'Search',
      description: 'Search',
      inputSchemaCode: '{ q: z.string() }',
      form: { fields: [{ name: 'q', inputKey: 'q', fieldType: 'text', selector: sel('#q') }] },
    };
    assertParses(renderSiteTemplate('tool-handler-form.ts', tool), 'form-no-submit');
  });

  it('action handler for a button tool', () => {
    const tool = {
      name: 'add',
      title: 'Add',
      description: 'Add to cart',
      inputSchemaCode: '{}',
      pageUrl: 'https://example.com/p',
      button: { selector: sel('#add', ['button.add']) },
    };
    assertParses(renderSiteTemplate('tool-handler-action.ts', tool), 'action-button');
  });

  it('action handler for a navigation (link) tool', () => {
    const tool = {
      name: 'about',
      title: 'About',
      description: 'Go to about',
      inputSchemaCode: '{}',
      link: { href: 'https://example.com/about', isNavigation: true },
    };
    assertParses(renderSiteTemplate('tool-handler-action.ts', tool), 'action-link');
  });

  it('stays valid even with adversarial quote/backslash-bearing selectors and urls', () => {
    const nasty = '#a\'b\\c"d';
    const tool = {
      name: 'evil',
      title: "ti'tle\\x",
      description: 'd',
      inputSchemaCode: '{ q: z.string() }',
      pageUrl: "https://x/'+1+'",
      form: {
        fields: [
          { name: "q'k", inputKey: 'q_k', fieldType: 'text', selector: sel(nasty, [nasty + '2']) },
        ],
        submitButton: sel(nasty),
      },
    };
    assertParses(renderSiteTemplate('tool-handler-form.ts', tool), 'form-adversarial');

    const linkTool = {
      name: 'go',
      title: 'Go',
      description: 'd',
      inputSchemaCode: '{}',
      link: { href: "https://x/'); evil(); ('", isNavigation: true },
    };
    assertParses(renderSiteTemplate('tool-handler-action.ts', linkTool), 'action-adversarial');
  });
});
