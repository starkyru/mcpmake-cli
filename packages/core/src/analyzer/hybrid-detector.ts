/**
 * Hybrid Detector: classifies form elements as either API-backed or browser-only.
 *
 * After crawling a site, we have both DOM forms (from dom-parser) and network
 * requests captured during the crawl (HAR entries). This module correlates them:
 * - If a form submission triggers a JSON API call, mark it as 'api' (use HTTP fetch)
 * - If a form has no corresponding API call, mark it as 'browser' (use Playwright)
 */

import type { Entry } from 'har-format';
import type { FormDescriptor } from '../types/site.js';
import { logger } from '../utils/logger.js';

export interface HybridClassification {
  formId: string;
  strategy: 'api' | 'browser';
  apiEndpoint?: string; // If strategy is 'api', the JSON endpoint URL
}

const JSON_MIME_TYPES = [
  'application/json',
  'application/ld+json',
  'application/vnd.api+json',
  'text/json',
];

/**
 * Classify each form as either API-backed or browser-only.
 *
 * Matching heuristics:
 * 1. If the form's action URL matches a HAR entry URL, and that entry
 *    has a JSON response, classify as 'api'.
 * 2. If a HAR entry was a POST/PUT/PATCH to the same path as the form action,
 *    classify as 'api'.
 * 3. If a HAR entry's URL path contains the form action's path segment,
 *    and the entry has a JSON response, classify as 'api'.
 * 4. Otherwise, classify as 'browser'.
 */
export function classifyForms(
  forms: FormDescriptor[],
  harEntries: Entry[],
): HybridClassification[] {
  // Pre-filter HAR entries to only JSON-responding API calls
  const apiEntries = harEntries.filter((entry) => {
    const responseMime = entry.response.content?.mimeType ?? '';
    return JSON_MIME_TYPES.some((m) => responseMime.includes(m));
  });

  logger.debug(`Hybrid detector: ${forms.length} forms, ${apiEntries.length} JSON API entries`);

  return forms.map((form) => {
    const match = findMatchingApiEntry(form, apiEntries);

    if (match) {
      logger.debug(`Form ${form.formId} → API endpoint: ${match}`);
      return {
        formId: form.formId,
        strategy: 'api' as const,
        apiEndpoint: match,
      };
    }

    logger.debug(`Form ${form.formId} → browser-only`);
    return {
      formId: form.formId,
      strategy: 'browser' as const,
    };
  });
}

/**
 * Try to find a HAR entry that corresponds to the given form submission.
 * Returns the API endpoint URL if found, or undefined.
 */
function findMatchingApiEntry(form: FormDescriptor, apiEntries: Entry[]): string | undefined {
  if (!form.action) return undefined;

  let formActionPath: string;
  try {
    const actionUrl = new URL(form.action);
    formActionPath = actionUrl.pathname;
  } catch {
    // Relative URL — use as-is
    formActionPath = form.action;
  }

  // Normalize: remove trailing slash
  formActionPath = formActionPath.replace(/\/$/, '');

  if (!formActionPath || formActionPath === '') return undefined;

  for (const entry of apiEntries) {
    const entryMethod = entry.request.method.toUpperCase();

    // Only match mutating methods for form submissions
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(entryMethod) && form.method === 'post') {
      continue;
    }

    let entryPath: string;
    try {
      entryPath = new URL(entry.request.url).pathname.replace(/\/$/, '');
    } catch {
      continue;
    }

    // Exact path match
    if (entryPath === formActionPath) {
      return entry.request.url;
    }

    // Path containment: the form action path is a prefix of the entry path
    // (e.g., form action="/api/users" matches entry "/api/users/register")
    if (entryPath.startsWith(formActionPath + '/') || formActionPath.startsWith(entryPath + '/')) {
      return entry.request.url;
    }
  }

  return undefined;
}
