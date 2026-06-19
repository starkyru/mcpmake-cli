/**
 * Pure helpers for the `mcpmake rescan` command: collecting fragile selectors
 * to heal and summarizing a diff. Kept free of Playwright/LLM/IO so they can be
 * unit-tested directly; the browser + LLM orchestration lives in the command.
 */

import type { SiteDescriptor, SelectorSet, RescanResult, ElementType } from '../types/site.js';

/** A low-confidence selector flagged for healing, with a live object reference. */
export interface LowConfidenceSelector {
  /** URL of the page this selector lives on (for navigation during healing). */
  pageUrl: string;
  /** Human-readable description used in the heal prompt. */
  description: string;
  /**
   * The actual SelectorSet object inside the descriptor. Mutating this (via
   * Object.assign) updates the descriptor in place so regeneration picks up
   * the healed selector.
   */
  selector: SelectorSet;
}

/**
 * Walk a SiteDescriptor and collect every selector whose confidence is below
 * `threshold` (default 0.5 — i.e. the brittle css-path / xpath fallbacks).
 */
export function collectLowConfidenceSelectors(
  site: SiteDescriptor,
  threshold = 0.5,
): LowConfidenceSelector[] {
  const out: LowConfidenceSelector[] = [];

  const consider = (selector: SelectorSet | undefined, pageUrl: string, description: string) => {
    if (selector && selector.confidence < threshold) {
      out.push({ pageUrl, description, selector });
    }
  };

  for (const page of site.pages) {
    for (const form of page.forms) {
      const formName = form.semanticName ?? form.formId;
      consider(form.selector, page.url, `form "${formName}"`);
      consider(form.submitButton, page.url, `submit button of form "${formName}"`);
      for (const field of form.fields) {
        consider(
          field.selector,
          page.url,
          `field "${field.name}" (${field.label ?? field.fieldType}) in form "${formName}"`,
        );
      }
    }
    for (const button of page.buttons) {
      consider(
        button.selector,
        page.url,
        `button "${button.text ?? button.semanticAction ?? button.buttonId}"`,
      );
    }
    for (const link of page.links) {
      consider(link.selector, page.url, `link "${link.text ?? link.href}"`);
    }
  }

  return out;
}

export interface ChangeCounts {
  page: number;
  form: number;
  field: number;
  button: number;
  link: number;
}

export interface RescanSummary {
  previousVersion: number;
  newVersion: number;
  added: ChangeCounts;
  removed: ChangeCounts;
  modified: ChangeCounts;
  brokenSelectors: number;
  totalChanges: number;
}

function emptyCounts(): ChangeCounts {
  return { page: 0, form: 0, field: 0, button: 0, link: 0 };
}

/** Summarize a RescanResult into per-kind change counts for reporting. */
export function summarizeRescan(result: RescanResult): RescanSummary {
  const added = emptyCounts();
  const removed = emptyCounts();
  const modified = emptyCounts();

  const bump = (counts: ChangeCounts, elementType: ElementType) => {
    counts[elementType] += 1;
  };

  for (const change of result.changes) {
    switch (change.changeType) {
      case 'added':
        bump(added, change.elementType);
        break;
      case 'removed':
        bump(removed, change.elementType);
        break;
      case 'modified':
        bump(modified, change.elementType);
        break;
      // 'selector-broken' is reported separately via brokenSelectors.
    }
  }

  return {
    previousVersion: result.previousVersion,
    newVersion: result.newVersion,
    added,
    removed,
    modified,
    brokenSelectors: result.brokenSelectors.length,
    totalChanges: result.changes.length,
  };
}
