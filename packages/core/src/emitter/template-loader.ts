import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, 'templates');

const templateCache = new Map<string, Handlebars.TemplateDelegate>();

Handlebars.registerHelper('eq', function (a: unknown, b: unknown) {
  return a === b;
});

Handlebars.registerHelper('capitalize', function (str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
});

// Emit a value as a valid JS/TS literal via JSON.stringify. Safe for embedding
// untrusted spec-derived strings (e.g. OpenAPI security-scheme names) into
// generated code: JSON.stringify produces a double-quoted literal with all
// special characters escaped, so the value can never break out of the literal.
// Registered on the shared Handlebars singleton, so worker templates (which
// import the same instance) can use it too.
Handlebars.registerHelper('json', function (value: unknown) {
  return JSON.stringify(value === undefined ? null : value);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderTemplate(name: string, data: any): string {
  if (!templateCache.has(name)) {
    const templatePath = resolve(TEMPLATE_DIR, `${name}.hbs`);
    if (!templatePath.startsWith(TEMPLATE_DIR + '/')) {
      throw new Error(`Invalid template name: ${name}`);
    }
    const raw = readFileSync(templatePath, 'utf-8');
    templateCache.set(name, Handlebars.compile(raw, { noEscape: true }));
  }
  return templateCache.get(name)!(data);
}
