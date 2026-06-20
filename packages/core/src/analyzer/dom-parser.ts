/**
 * Parses a Playwright page's DOM to extract interactive elements:
 * forms (with fields), standalone buttons, and navigation links.
 */

import type { Page } from 'playwright';
import type {
  PageDescriptor,
  FormDescriptor,
  FormFieldDescriptor,
  FormFieldType,
  ButtonDescriptor,
  LinkDescriptor,
} from '../types/site.js';
import { buildSelectorSet } from './selector-builder.js';
import { logger } from '../utils/logger.js';
import crypto from 'node:crypto';

/** Maximum elements to extract per category to avoid huge outputs. */
const MAX_FORMS = 20;
const MAX_BUTTONS = 50;
const MAX_LINKS = 100;

/**
 * Parse a single page and extract all interactive elements.
 */
export async function parsePage(page: Page): Promise<PageDescriptor> {
  const url = page.url();
  const title = await page.title().catch(() => undefined);

  const forms = await extractForms(page);
  const buttons = await extractStandaloneButtons(page);
  const links = await extractLinks(page);

  const pageId = generateStableId('page', url);

  return {
    pageId,
    url,
    title,
    forms,
    buttons,
    links,
    analyzedAt: new Date().toISOString(),
  };
}

// ─── Form Extraction ────────────────────────────────────────────────

async function extractForms(page: Page): Promise<FormDescriptor[]> {
  const formElements = await page.$$('form');
  const forms: FormDescriptor[] = [];

  for (const formEl of formElements.slice(0, MAX_FORMS)) {
    try {
      const form = await extractSingleForm(page, formEl);
      if (form.fields.length > 0) {
        forms.push(form);
      }
    } catch (err) {
      logger.debug(`Skipping form: ${err}`);
    }
  }

  return forms;
}

async function extractSingleForm(
  page: Page,
  formEl: Awaited<ReturnType<Page['$']>>,
): Promise<FormDescriptor> {
  if (!formEl) throw new Error('Form element is null');

  const formAttrs = await formEl.evaluate((el) => ({
    action: (el as HTMLFormElement).action || '',
    method: ((el as HTMLFormElement).method || 'get').toLowerCase(),
    id: el.id || '',
    name: el.getAttribute('name') || '',
  }));

  const selector = await buildSelectorSet(page, formEl);
  const fields = await extractFormFields(page, formEl);

  // Find submit button
  let submitButton;
  const submitEl =
    (await formEl.$('button[type="submit"]')) ??
    (await formEl.$('input[type="submit"]')) ??
    (await formEl.$('button:not([type])'));
  if (submitEl) {
    submitButton = await buildSelectorSet(page, submitEl);
  }

  const formId = generateStableId(
    'form',
    formAttrs.action || formAttrs.id || formAttrs.name || selector.primary,
  );

  return {
    formId,
    action: formAttrs.action || undefined,
    method: formAttrs.method === 'post' ? 'post' : 'get',
    selector,
    fields,
    submitButton,
  };
}

async function extractFormFields(
  page: Page,
  formEl: Awaited<ReturnType<Page['$']>>,
): Promise<FormFieldDescriptor[]> {
  if (!formEl) return [];

  const fieldElements = await formEl.$$(
    'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]), ' +
      'textarea, select',
  );

  const fields: FormFieldDescriptor[] = [];

  for (const fieldEl of fieldElements) {
    try {
      const attrs = await fieldEl.evaluate((el) => {
        const input = el as HTMLInputElement;
        return {
          tagName: el.tagName.toLowerCase(),
          name: input.name || '',
          type: input.type || 'text',
          placeholder: input.placeholder || '',
          required: input.required || false,
          value: input.value || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          // Get associated label
          label: input.labels?.[0]?.textContent?.trim() || '',
          // Get select options as label/value pairs. The visible label and
          // the submitted value routinely differ; Playwright's selectOption
          // matches by value, so we must preserve both rather than collapsing
          // to one string.
          optionPairs:
            el.tagName === 'SELECT'
              ? Array.from((el as HTMLSelectElement).options).map((o) => ({
                  label: (o.text || o.value || '').trim(),
                  value: o.value ?? '',
                }))
              : undefined,
        };
      });

      const fieldType = mapFieldType(attrs.tagName, attrs.type);
      const selector = await buildSelectorSet(page, fieldEl);
      const label = attrs.label || attrs.ariaLabel || attrs.placeholder || attrs.name;

      // Skip fields with no name and no useful label
      if (!attrs.name && !label) continue;

      fields.push({
        name: attrs.name || label.replace(/\s+/g, '_').toLowerCase(),
        fieldType,
        selector,
        label: label || undefined,
        placeholder: attrs.placeholder || undefined,
        required: attrs.required,
        // Keep the visible labels for human-facing enum docs, plus the
        // label/value pairs the handler needs to drive selectOption by value.
        options: attrs.optionPairs ? attrs.optionPairs.map((o) => o.label) : undefined,
        optionPairs: attrs.optionPairs,
        defaultValue: attrs.value || undefined,
      });
    } catch (err) {
      logger.debug(`Skipping form field: ${err}`);
    }
  }

  return fields;
}

// ─── Button Extraction ──────────────────────────────────────────────

async function extractStandaloneButtons(page: Page): Promise<ButtonDescriptor[]> {
  // Find buttons that are NOT inside a form (form buttons are handled by extractForms)
  const buttonElements = await page.$$(
    'button:not(form button):not(form input), ' + '[role="button"]:not(form [role="button"])',
  );

  const buttons: ButtonDescriptor[] = [];

  for (const btnEl of buttonElements.slice(0, MAX_BUTTONS)) {
    try {
      const attrs = await btnEl.evaluate((el) => ({
        tagName: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || 'button',
        text: el.textContent?.trim().slice(0, 80) || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        href: el.getAttribute('href') || '',
        isHidden:
          (el as HTMLElement).offsetParent === null ||
          getComputedStyle(el).display === 'none' ||
          getComputedStyle(el).visibility === 'hidden',
      }));

      // Skip hidden or empty buttons
      if (attrs.isHidden) continue;
      if (!attrs.text && !attrs.ariaLabel) continue;

      const selector = await buildSelectorSet(page, btnEl);
      const buttonId = generateStableId('btn', attrs.text || attrs.ariaLabel || selector.primary);

      const buttonType: ButtonDescriptor['type'] = attrs.href
        ? 'link'
        : attrs.type === 'submit'
          ? 'submit'
          : 'button';

      buttons.push({
        buttonId,
        selector,
        text: attrs.text || undefined,
        ariaLabel: attrs.ariaLabel || undefined,
        type: buttonType,
        href: attrs.href || undefined,
      });
    } catch (err) {
      logger.debug(`Skipping button: ${err}`);
    }
  }

  return buttons;
}

// ─── Link Extraction ────────────────────────────────────────────────

async function extractLinks(page: Page): Promise<LinkDescriptor[]> {
  const linkElements = await page.$$('a[href]');
  const links: LinkDescriptor[] = [];
  const seenHrefs = new Set<string>();
  const pageOrigin = new URL(page.url()).origin;

  for (const linkEl of linkElements.slice(0, MAX_LINKS * 2)) {
    // Over-fetch then filter
    try {
      const attrs = await linkEl.evaluate((el) => ({
        href: (el as HTMLAnchorElement).href,
        text: el.textContent?.trim().slice(0, 80) || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        isHidden:
          (el as HTMLElement).offsetParent === null ||
          getComputedStyle(el).display === 'none' ||
          getComputedStyle(el).visibility === 'hidden',
        target: el.getAttribute('target') || '',
      }));

      if (attrs.isHidden) continue;
      if (!attrs.text && !attrs.ariaLabel) continue;

      // Deduplicate by href
      const normalizedHref = normalizeHref(attrs.href);
      if (seenHrefs.has(normalizedHref)) continue;
      seenHrefs.add(normalizedHref);

      // Skip non-http links (javascript:, mailto:, tel:, #)
      if (!attrs.href.startsWith('http')) continue;

      // Same-origin must be decided by parsed URL.origin, never a string
      // prefix: `https://example.com.attacker.test` starts with
      // `https://example.com` but is a different origin.
      const isNavigation = isSameOrigin(attrs.href, pageOrigin) && !attrs.href.includes('#');

      const selector = await buildSelectorSet(page, linkEl);
      const linkId = generateStableId('link', normalizedHref);

      links.push({
        linkId,
        selector,
        text: attrs.text || undefined,
        href: attrs.href,
        isNavigation,
      });

      if (links.length >= MAX_LINKS) break;
    } catch (err) {
      logger.debug(`Skipping link: ${err}`);
    }
  }

  return links;
}

// ─── Helpers ────────────────────────────────────────────────────────

function mapFieldType(tagName: string, type: string): FormFieldType {
  if (tagName === 'textarea') return 'textarea';
  if (tagName === 'select') return 'select';

  const typeMap: Record<string, FormFieldType> = {
    text: 'text',
    email: 'email',
    password: 'password',
    number: 'number',
    tel: 'tel',
    url: 'url',
    search: 'search',
    checkbox: 'checkbox',
    radio: 'radio',
    file: 'file',
    date: 'date',
    'datetime-local': 'datetime-local',
    color: 'color',
    range: 'range',
    hidden: 'hidden',
  };

  return typeMap[type] || 'other';
}

/**
 * True only when `href` parses to the exact same origin as `origin`.
 * Guards against prefix-spoofing hosts such as
 * `https://example.com.attacker.test` matching base `https://example.com`.
 * Exported for regression testing of the same-origin admission logic.
 */
export function isSameOrigin(href: string, origin: string): boolean {
  try {
    return new URL(href).origin === origin;
  } catch {
    return false;
  }
}

function normalizeHref(href: string): string {
  try {
    const url = new URL(href);
    // Remove trailing slash and fragment
    return `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}`;
  } catch {
    return href;
  }
}

/** Generate a deterministic, stable ID from a category and key. */
function generateStableId(category: string, key: string): string {
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${category}_${hash}`;
}
