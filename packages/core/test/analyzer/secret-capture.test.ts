import { describe, it, expect } from 'vitest';
import { isSensitiveField } from '../../src/analyzer/dom-parser.js';
import { scaffoldSiteSharedModules } from '../../src/emitter/site-scaffolder.js';
import type {
  SiteDescriptor,
  SiteProjectManifest,
  FormFieldDescriptor,
  SelectorSet,
} from '../../src/types/site.js';

const sel = (primary: string): SelectorSet => ({
  primary,
  fallbacks: [],
  strategy: 'id',
  confidence: 0.9,
});

describe('D-M9: live secret/credential values are not captured', () => {
  describe('isSensitiveField', () => {
    it('flags password inputs by type', () => {
      expect(isSensitiveField('userpass', 'password', '')).toBe(true);
      // Even a benign name with type=password is sensitive.
      expect(isSensitiveField('field1', 'password', '')).toBe(true);
    });

    it('flags credential-hinted names and autocomplete tokens', () => {
      expect(isSensitiveField('api_token', 'text', '')).toBe(true);
      expect(isSensitiveField('client_secret', 'text', '')).toBe(true);
      expect(isSensitiveField('otp', 'text', '')).toBe(true);
      expect(isSensitiveField('cc-number', 'text', '')).toBe(true);
      expect(isSensitiveField('cvv', 'text', '')).toBe(true);
      expect(isSensitiveField('ssn', 'text', '')).toBe(true);
      expect(isSensitiveField('account_pin', 'text', '')).toBe(true);
      expect(isSensitiveField('x', 'text', 'current-password')).toBe(true);
      expect(isSensitiveField('x', 'text', 'one-time-code')).toBe(true);
      expect(isSensitiveField('x', 'text', 'cc-number')).toBe(true);
    });

    it('does NOT flag ordinary fields', () => {
      expect(isSensitiveField('email', 'email', 'email')).toBe(false);
      expect(isSensitiveField('first_name', 'text', 'given-name')).toBe(false);
      expect(isSensitiveField('quantity', 'number', '')).toBe(false);
      expect(isSensitiveField('country', 'select', '')).toBe(false);
    });

    it('does NOT misfire on words that merely contain a short token', () => {
      // "pin" appears inside these but only as a substring, not a whole token.
      expect(isSensitiveField('shipping_address', 'text', '')).toBe(false);
      expect(isSensitiveField('pinterest_handle', 'text', '')).toBe(false);
      expect(isSensitiveField('zip', 'text', '')).toBe(false);
    });
  });

  function manifestWith(fields: FormFieldDescriptor[]): SiteProjectManifest {
    const siteDescriptor: SiteDescriptor = {
      siteId: 'site_x',
      baseUrl: 'https://example.com',
      pages: [
        {
          pageId: 'page_x',
          url: 'https://example.com/login',
          title: 'Login',
          forms: [
            {
              formId: 'form_login',
              method: 'post',
              selector: sel('#form'),
              fields,
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

    return {
      serverName: 'login-site',
      serverVersion: '0.1.0',
      baseUrl: 'https://example.com',
      transport: 'stdio',
      siteDescriptor,
      tools: [],
      envVars: [],
      browserConfig: {
        headless: true,
        idleTimeoutMs: 60_000,
        viewport: { width: 1280, height: 720 },
      },
    };
  }

  function descriptorJson(manifest: SiteProjectManifest): string {
    const units = scaffoldSiteSharedModules(manifest);
    const unit = units.find((u) => u.filePath === 'src/site-descriptor.json');
    if (!unit) throw new Error('site-descriptor.json not scaffolded');
    return unit.content;
  }

  it('strips a captured password value from the generated site-descriptor.json', () => {
    // Simulate a descriptor where a live password value leaked through
    // (e.g. older parser / hand-edited input). The scaffolder must not emit it.
    const secret = 'hunter2-SUPER-SECRET';
    const json = descriptorJson(
      manifestWith([
        {
          name: 'password',
          fieldType: 'password',
          selector: sel('#pw'),
          required: true,
          defaultValue: secret,
        },
        {
          name: 'email',
          fieldType: 'email',
          selector: sel('#em'),
          required: true,
          defaultValue: 'user@example.com',
        },
      ]),
    );

    expect(json).not.toContain(secret);
    // Non-sensitive defaults are preserved so form tools still work.
    expect(json).toContain('user@example.com');

    const parsed = JSON.parse(json) as SiteDescriptor;
    const pwField = parsed.pages[0].forms[0].fields.find((f) => f.fieldType === 'password');
    expect(pwField?.defaultValue).toBeUndefined();
    // Field shape (name, type, required, selector) still flows through.
    expect(pwField?.name).toBe('password');
    expect(pwField?.required).toBe(true);
  });

  it('strips credential-hinted text field values too', () => {
    const token = 'tok_live_abc123XYZ';
    const json = descriptorJson(
      manifestWith([
        {
          name: 'api_token',
          fieldType: 'text',
          selector: sel('#tok'),
          required: false,
          defaultValue: token,
        },
      ]),
    );

    expect(json).not.toContain(token);
    const parsed = JSON.parse(json) as SiteDescriptor;
    expect(parsed.pages[0].forms[0].fields[0].defaultValue).toBeUndefined();
  });
});
