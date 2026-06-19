/**
 * Template loader for site (Playwright-based) MCP server templates.
 * Parallel to template-loader.ts but reads from site-templates/.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_TEMPLATE_DIR = resolve(__dirname, 'site-templates');

const siteTemplateCache = new Map<string, Handlebars.TemplateDelegate>();

// Register helpers (same as template-loader.ts — Handlebars helpers are global)
// These may already be registered; Handlebars silently overwrites, which is fine.
Handlebars.registerHelper('eq', function (a: unknown, b: unknown) {
  return a === b;
});

Handlebars.registerHelper('capitalize', function (str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
});

// Escape a value for safe interpolation inside a SINGLE-QUOTED JS/TS string
// literal in generated code. Critical for any string derived from crawled
// (untrusted) site DOM — selectors, hrefs, field-name keys — so it can never
// break out of the literal and inject code into the generated server.
Handlebars.registerHelper('jsString', function (value: unknown) {
  const s = value === null || value === undefined ? '' : String(value);
  return (
    s
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      // Drop any remaining control chars that could terminate the literal.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  );
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderSiteTemplate(name: string, data: any): string {
  if (!siteTemplateCache.has(name)) {
    const templatePath = resolve(SITE_TEMPLATE_DIR, `${name}.hbs`);
    if (!templatePath.startsWith(SITE_TEMPLATE_DIR + '/')) {
      throw new Error(`Invalid site template name: ${name}`);
    }
    const raw = readFileSync(templatePath, 'utf-8');
    siteTemplateCache.set(name, Handlebars.compile(raw, { noEscape: true }));
  }
  return siteTemplateCache.get(name)!(data);
}
