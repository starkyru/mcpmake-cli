/**
 * Template loader for Cloudflare Workers MCP server templates.
 * Parallel to template-loader.ts but reads from worker-templates/.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_TEMPLATE_DIR = resolve(__dirname, 'worker-templates');

const workerTemplateCache = new Map<string, Handlebars.TemplateDelegate>();

// Register helpers (same as template-loader.ts — Handlebars helpers are global).
// These may already be registered; Handlebars silently overwrites, which is fine.
Handlebars.registerHelper('eq', function (a: unknown, b: unknown) {
  return a === b;
});

Handlebars.registerHelper('capitalize', function (str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderWorkerTemplate(name: string, data: any): string {
  if (!workerTemplateCache.has(name)) {
    const templatePath = resolve(WORKER_TEMPLATE_DIR, `${name}.hbs`);
    if (!templatePath.startsWith(WORKER_TEMPLATE_DIR + '/')) {
      throw new Error(`Invalid worker template name: ${name}`);
    }
    const raw = readFileSync(templatePath, 'utf-8');
    workerTemplateCache.set(name, Handlebars.compile(raw, { noEscape: true }));
  }
  return workerTemplateCache.get(name)!(data);
}
