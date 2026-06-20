import { describe, it, expect } from 'vitest';
import { generateSiteTools } from '../../src/site-transformer/tool-generator.js';
import { renderSiteTemplate } from '../../src/emitter/site-template-loader.js';
import type {
  SiteDescriptor,
  SiteToolDefinition,
  FormFieldDescriptor,
  SelectorSet,
} from '../../src/types/site.js';

const sel = (primary: string): SelectorSet => ({
  primary,
  fallbacks: [],
  strategy: 'id',
  confidence: 0.9,
});

function site(fields: FormFieldDescriptor[]): SiteDescriptor {
  return {
    siteId: 'site_x',
    baseUrl: 'https://example.com',
    pages: [
      {
        pageId: 'page_x',
        url: 'https://example.com/signup',
        title: 'Signup',
        forms: [
          {
            formId: 'form_signup',
            method: 'post',
            selector: sel('#form'),
            fields,
            semanticName: 'signup',
          },
        ],
        buttons: [],
        links: [],
        analyzedAt: '2026-06-20T00:00:00.000Z',
      },
    ],
    analyzedAt: '2026-06-20T00:00:00.000Z',
    version: 1,
    crawlDepth: 1,
    metadata: {},
  };
}

function formTool(tools: SiteToolDefinition[]): SiteToolDefinition {
  const t = tools.find((x) => x.toolType === 'page-action');
  if (!t) throw new Error('no form tool generated');
  return t;
}

describe('D-H4: website form input keys match handler keys', () => {
  it('uses one stable inputKey in BOTH the schema and the rendered handler', () => {
    const tools = generateSiteTools(
      site([
        { name: 'first-name', fieldType: 'text', selector: sel('#fn'), required: true },
        { name: 'user[email]', fieldType: 'email', selector: sel('#em'), required: true },
      ]),
    );
    const tool = formTool(tools);

    // Schema declares JSON-stringified, valid keys (no bare hyphenated keys).
    expect(tool.inputSchemaCode).toContain('"first_name":');
    expect(tool.inputSchemaCode).toContain('"user_email_":');
    expect(tool.inputSchemaCode).not.toContain('first-name:');

    // Every field carries an inputKey, and the handler indexes by that key.
    const keys = tool.form!.fields.map((f) => f.inputKey);
    expect(keys).toEqual(['first_name', 'user_email_']);

    const handler = renderSiteTemplate('tool-handler-form.ts', tool);
    expect(handler).toContain("input as Record<string, unknown>)['first_name']");
    expect(handler).toContain("input as Record<string, unknown>)['user_email_']");
    // The original DOM name is never read as the input key.
    expect(handler).not.toContain("['first-name']");
    expect(handler).not.toContain("['user[email]']");
  });

  it('deduplicates inputKey when sanitization collides (foo-bar vs foo_bar)', () => {
    const tools = generateSiteTools(
      site([
        { name: 'foo-bar', fieldType: 'text', selector: sel('#a'), required: false },
        { name: 'foo_bar', fieldType: 'text', selector: sel('#b'), required: false },
      ]),
    );
    const tool = formTool(tools);
    const keys = tool.form!.fields.map((f) => f.inputKey);
    expect(keys).toEqual(['foo_bar', 'foo_bar_2']);
    // No duplicate schema property.
    expect(tool.inputSchemaCode).toContain('"foo_bar":');
    expect(tool.inputSchemaCode).toContain('"foo_bar_2":');
  });
});

describe('D-H6/D-M6: file and select fields are handled safely', () => {
  it('omits file inputs instead of emitting a broken upload tool', () => {
    const tools = generateSiteTools(
      site([
        { name: 'avatar', fieldType: 'file', selector: sel('#file'), required: false },
        { name: 'name', fieldType: 'text', selector: sel('#name'), required: true },
      ]),
    );
    const tool = formTool(tools);
    const keys = tool.form!.fields.map((f) => f.name);
    expect(keys).toEqual(['name']);
    expect(tool.inputSchemaCode).not.toContain('avatar');
    // page.fill is never emitted for a file input.
    const handler = renderSiteTemplate('tool-handler-form.ts', tool);
    expect(handler).not.toContain("['avatar']");
  });

  it('builds the select enum from option VALUES, not visible labels', () => {
    const tools = generateSiteTools(
      site([
        {
          name: 'country',
          fieldType: 'select',
          selector: sel('#country'),
          required: true,
          options: ['United States', 'Canada'],
          optionPairs: [
            { label: 'United States', value: 'us' },
            { label: 'Canada', value: 'ca' },
          ],
        },
      ]),
    );
    const tool = formTool(tools);
    // Enum validates against the values selectOption matches by.
    expect(tool.inputSchemaCode).toContain("z.enum(['us', 'ca'])");
    expect(tool.inputSchemaCode).not.toContain('United States');
  });
});
