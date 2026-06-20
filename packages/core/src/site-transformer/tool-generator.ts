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
import { logger } from '../utils/logger.js';

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
  // Skip forms with no visible fields. File inputs are dropped here (with a
  // warning) rather than emitted: Playwright fills them via setInputFiles, not
  // page.fill, and modeling them as strings would generate a tool that looks
  // valid but can never upload a file. (D-H6 / D-M6)
  const visibleFields: FormFieldDescriptor[] = [];
  for (const field of form.fields) {
    if (field.fieldType === 'hidden') continue;
    if (field.fieldType === 'file') {
      logger.warn(
        `Omitting file input "${field.name || field.label || '(unnamed)'}" from form ` +
          `${form.semanticName || form.formId}: file uploads are not supported by generated ` +
          `website tools.`,
      );
      continue;
    }
    visibleFields.push(field);
  }
  if (visibleFields.length === 0) return null;

  // Assign each field a stable, deduplicated MCP input key. The generated
  // schema property and the generated handler key must agree, and the raw DOM
  // name (e.g. "first-name", "user[email]") is rarely a valid/unique JS
  // identifier. Selectors still drive the actual DOM, so the original name is
  // not needed at fill time. (D-H4)
  const keyedFields = assignInputKeys(visibleFields);

  // Generate tool name from semantic name or form fields
  const rawName = form.semanticName || inferFormName(form);
  const name = deduplicateName(toToolName(rawName), usedNames);

  // Build Zod input schema from form fields
  const inputSchemaCode = buildFormInputSchema(keyedFields);

  // Pass the file-filtered, input-key-annotated fields to the handler template
  // so it iterates exactly the same set of keys the schema declares.
  const handlerForm: FormDescriptor = { ...form, fields: keyedFields };

  // Collect all selectors this tool depends on
  const selectors: SelectorSet[] = [form.selector];
  for (const field of keyedFields) {
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
    form: handlerForm,
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
    // Emit the property as a JSON-stringified key so any input key (incl. ones
    // with hyphens or leading digits) is a valid, quoted object key — and use
    // the SAME stable inputKey the handler reads.
    const key = field.inputKey ?? sanitizeFieldName(field.name);
    fieldLines.push(
      `  ${JSON.stringify(key)}: ${zodType}${required}.describe('${escapeString(desc)}'),`,
    );
  }

  return `z.object({\n${fieldLines.join('\n')}\n})`;
}

/**
 * Build a Zod enum from a select/radio field's options. <select> options carry
 * distinct labels and submit *values*; Playwright's selectOption matches by
 * value, so the schema must validate against values, not visible labels.
 */
function buildOptionEnum(field: FormFieldDescriptor): string | null {
  // Prefer the label/value pairs (values are what get submitted/matched).
  if (field.optionPairs && field.optionPairs.length > 0) {
    const values = field.optionPairs.map((o) => o.value);
    const unique = [...new Set(values)];
    if (unique.length > 0) {
      const opts = unique.map((v) => `'${escapeString(v)}'`).join(', ');
      return `z.enum([${opts}])`;
    }
  }
  // Fallback for older descriptors that only captured labels.
  if (field.options && field.options.length > 0) {
    const unique = [...new Set(field.options)];
    const opts = unique.map((o) => `'${escapeString(o)}'`).join(', ');
    return `z.enum([${opts}])`;
  }
  return null;
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
      return buildOptionEnum(field) ?? 'z.string()';
    case 'radio':
      return buildOptionEnum(field) ?? 'z.string()';
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

/**
 * Return clones of the given fields, each annotated with a stable, unique
 * `inputKey`. Sanitization can map distinct DOM names onto the same key
 * (e.g. `foo-bar` and `foo_bar`), which would otherwise produce duplicate
 * schema properties and a key the handler can't disambiguate; collisions are
 * resolved by appending a numeric suffix. The handler and schema both read
 * this key, so they always agree.
 */
function assignInputKeys(fields: FormFieldDescriptor[]): FormFieldDescriptor[] {
  const usedKeys = new Set<string>(['sessionId']);
  return fields.map((field) => {
    const base = sanitizeFieldName(field.name || field.label || 'field');
    let candidate = base;
    let suffix = 2;
    while (usedKeys.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix++;
    }
    usedKeys.add(candidate);
    return { ...field, inputKey: candidate };
  });
}

function escapeString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}
