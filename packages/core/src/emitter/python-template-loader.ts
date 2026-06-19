/**
 * Template loader for Python MCP server templates.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_TEMPLATE_DIR = resolve(__dirname, 'python-templates');

const pythonTemplateCache = new Map<string, Handlebars.TemplateDelegate>();

Handlebars.registerHelper('eq', function (a: unknown, b: unknown) {
  return a === b;
});

Handlebars.registerHelper('pyDocstring', function (str: string) {
  if (!str) return '';
  return str.replace(/"""/g, '\\"\\"\\"').replace(/\\/g, '\\\\');
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderPythonTemplate(name: string, data: any): string {
  if (!pythonTemplateCache.has(name)) {
    const templatePath = resolve(PYTHON_TEMPLATE_DIR, `${name}.hbs`);
    if (!templatePath.startsWith(PYTHON_TEMPLATE_DIR + '/')) {
      throw new Error(`Invalid python template name: ${name}`);
    }
    const raw = readFileSync(templatePath, 'utf-8');
    pythonTemplateCache.set(name, Handlebars.compile(raw, { noEscape: true }));
  }
  return pythonTemplateCache.get(name)!(data);
}
