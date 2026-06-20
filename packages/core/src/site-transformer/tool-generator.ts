/**
 * Converts a SiteDescriptor into SiteToolDefinition[].
 *
 * Generates two levels of tools:
 * - Page-level: one tool per form (e.g., login(email, password))
 * - Action-level: one tool per standalone button/link
 * Plus built-in browser lifecycle tools.
 */

import type {
  SiteDescriptor,
  SiteToolDefinition,
  FormDescriptor,
  FormFieldDescriptor,
  ButtonDescriptor,
  LinkDescriptor,
  PageDescriptor,
  SelectorSet,
} from '../types/site.js';
import { buildBrowserLifecycleTools } from './browser-tools.js';
import { toToolName, toToolTitle, toFileName, toFunctionName } from '../transformer/naming.js';
import { escapeTemplateLiteral } from '../utils/sanitize.js';

/**
 * Generate all tools from a site descriptor.
 */
export function generateSiteTools(site: SiteDescriptor): SiteToolDefinition[] {
  const tools: SiteToolDefinition[] = [];
  const usedNames = new Set<string>();

  // 1. Built-in browser lifecycle tools
  const lifecycleTools = buildBrowserLifecycleTools();
  for (const tool of lifecycleTools) {
    usedNames.add(tool.name);
    tools.push(tool);
  }

  // 2. Navigation tool to the site's home page
  const homeTool = buildNavigationTool(
    'navigate_home',
    site.baseUrl,
    `Navigate to the home page at ${site.baseUrl}`,
    usedNames,
  );
  tools.push(homeTool);

  // 3. Page-level tools (forms)
  for (const page of site.pages) {
    for (const form of page.forms) {
      const tool = buildFormTool(page, form, usedNames);
      if (tool) tools.push(tool);
    }
  }

  // 4. Action-level tools (standalone buttons)
  for (const page of site.pages) {
    for (const button of page.buttons) {
      const tool = buildButtonTool(page, button, usedNames);
      if (tool) tools.push(tool);
    }
  }

  // 5. Navigation tools (key links)
  for (const page of site.pages) {
    for (const link of page.links) {
      if (!link.isNavigation) continue;
      const tool = buildLinkTool(page, link, usedNames);
      if (tool) tools.push(tool);
    }
  }

  return tools;
}

// ─── Form Tool Builder ──────────────────────────────────────────────

function buildFormTool(
  page: PageDescriptor,
  form: FormDescriptor,
  usedNames: Set<string>,
): SiteToolDefinition | null {
  // Skip forms with no visible fields
  const visibleFields = form.fields.filter((f) => f.fieldType !== 'hidden');
  if (visibleFields.length === 0) return null;

  // Generate tool name from semantic name or form fields
  const rawName = form.semanticName || inferFormName(form);
  const name = deduplicateName(toToolName(rawName), usedNames);

  // Build Zod input schema from form fields
  const inputSchemaCode = buildFormInputSchema(visibleFields);

  // Collect all selectors this tool depends on
  const selectors: SelectorSet[] = [form.selector];
  for (const field of visibleFields) {
    selectors.push(field.selector);
  }
  if (form.submitButton) selectors.push(form.submitButton);

  // Built from untrusted crawled DOM text — emitted into a backtick literal in
  // the site tool-handler templates, so escape for that context.
  const description = escapeTemplateLiteral(
    form.description ||
      `Fill and submit the ${form.semanticName || 'form'} on ${page.title || page.url}`,
  );

  return {
    name,
    title: toToolTitle(rawName),
    description,
    inputSchemaCode,
    fileName: toFileName(rawName),
    functionName: toFunctionName(rawName),
    toolType: 'page-action',
    pageId: page.pageId,
    pageUrl: page.url,
    form,
    selectors,
    returnsScreenshot: true,
    annotations: { readOnlyHint: false },
  };
}

// ─── Button Tool Builder ────────────────────────────────────────────

function buildButtonTool(
  page: PageDescriptor,
  button: ButtonDescriptor,
  usedNames: Set<string>,
): SiteToolDefinition | null {
  const rawName =
    button.semanticAction ||
    (button.text ? `click_${button.text.replace(/\s+/g, '_').toLowerCase()}` : null);
  if (!rawName) return null;

  const name = deduplicateName(toToolName(rawName), usedNames);

  // Buttons typically don't need input parameters beyond sessionId
  const inputSchemaCode = `z.object({
  sessionId: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Browser session ID'),
})`;

  const description = escapeTemplateLiteral(
    button.description ||
      `Click the "${button.text || button.ariaLabel}" button on ${page.title || page.url}`,
  );

  return {
    name,
    title: toToolTitle(rawName),
    description,
    inputSchemaCode,
    fileName: toFileName(rawName),
    functionName: toFunctionName(rawName),
    toolType: 'element-action',
    pageId: page.pageId,
    pageUrl: page.url,
    button,
    selectors: [button.selector],
    returnsScreenshot: true,
    annotations: { readOnlyHint: false },
  };
}

// ─── Link Tool Builder ──────────────────────────────────────────────

function buildLinkTool(
  page: PageDescriptor,
  link: LinkDescriptor,
  usedNames: Set<string>,
): SiteToolDefinition | null {
  const rawName =
    link.semanticAction ||
    (link.text ? `navigate_to_${link.text.replace(/\s+/g, '_').toLowerCase()}` : null);
  if (!rawName) return null;

  const name = deduplicateName(toToolName(rawName), usedNames);

  const inputSchemaCode = `z.object({
  sessionId: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Browser session ID'),
})`;

  const description = escapeTemplateLiteral(`Navigate to "${link.text}" at ${link.href}`);

  return {
    name,
    title: toToolTitle(rawName),
    description,
    inputSchemaCode,
    fileName: toFileName(rawName),
    functionName: toFunctionName(rawName),
    toolType: 'navigation',
    pageId: page.pageId,
    pageUrl: page.url,
    link,
    selectors: [link.selector],
    returnsScreenshot: true,
    annotations: { readOnlyHint: true },
  };
}

// ─── Navigation Helper ──────────────────────────────────────────────

function buildNavigationTool(
  rawName: string,
  url: string,
  description: string,
  usedNames: Set<string>,
): SiteToolDefinition {
  const name = deduplicateName(toToolName(rawName), usedNames);

  return {
    name,
    title: toToolTitle(rawName),
    description: escapeTemplateLiteral(description),
    inputSchemaCode: `z.object({
  sessionId: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Browser session ID'),
})`,
    fileName: toFileName(rawName),
    functionName: toFunctionName(rawName),
    toolType: 'navigation',
    pageUrl: url,
    selectors: [],
    returnsScreenshot: true,
    annotations: { readOnlyHint: true },
  };
}

// ─── Schema Builders ────────────────────────────────────────────────

function buildFormInputSchema(fields: FormFieldDescriptor[]): string {
  const fieldLines: string[] = [
    `  sessionId: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Browser session ID'),`,
  ];

  for (const field of fields) {
    const zodType = mapFieldToZodType(field);
    const desc = field.label || field.placeholder || field.name;
    const required = field.required ? '' : '.optional()';
    fieldLines.push(
      `  ${sanitizeFieldName(field.name)}: ${zodType}${required}.describe('${escapeString(desc)}'),`,
    );
  }

  return `z.object({\n${fieldLines.join('\n')}\n})`;
}

function mapFieldToZodType(field: FormFieldDescriptor): string {
  switch (field.fieldType) {
    case 'email':
      return 'z.string().email()';
    case 'number':
    case 'range':
      return 'z.number()';
    case 'checkbox':
      return 'z.boolean()';
    case 'url':
      return 'z.string().url()';
    case 'select':
      if (field.options && field.options.length > 0) {
        const opts = field.options.map((o) => `'${escapeString(o)}'`).join(', ');
        return `z.enum([${opts}])`;
      }
      return 'z.string()';
    case 'radio':
      if (field.options && field.options.length > 0) {
        const opts = field.options.map((o) => `'${escapeString(o)}'`).join(', ');
        return `z.enum([${opts}])`;
      }
      return 'z.string()';
    default:
      return 'z.string()';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Infer a form name from its fields when no semantic name is available. */
function inferFormName(form: FormDescriptor): string {
  const fieldNames = form.fields.map((f) => f.name.toLowerCase());

  // Common form patterns
  if (fieldNames.some((n) => n.includes('password'))) {
    if (
      fieldNames.some(
        (n) => n.includes('confirm') || n.includes('register') || n.includes('signup'),
      )
    ) {
      return 'register';
    }
    return 'login';
  }
  if (fieldNames.some((n) => n.includes('search') || n.includes('query') || n.includes('q'))) {
    return 'search';
  }
  if (
    fieldNames.some((n) => n.includes('email') && !fieldNames.some((n2) => n2.includes('password')))
  ) {
    return 'subscribe';
  }
  if (fieldNames.some((n) => n.includes('message') || n.includes('comment'))) {
    return 'send_message';
  }

  // Fallback: use first field name or form ID
  return form.formId.replace(/^form_/, 'submit_form_');
}

function deduplicateName(name: string, usedNames: Set<string>): string {
  let candidate = name;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${name}_${suffix}`;
    suffix++;
  }
  usedNames.add(candidate);
  return candidate;
}

function sanitizeFieldName(name: string): string {
  // Make valid JS identifier
  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
  return sanitized || '_field';
}

function escapeString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}
