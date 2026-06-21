/**
 * LLM-powered semantic analysis of crawled pages.
 *
 * Sends page structure to an LLM and infers
 * human-readable semantic names and descriptions for forms, buttons, and links.
 */

import type { PageDescriptor } from '../types/site.js';
import { extractJsonObject } from '../utils/json-extract.js';
import { logger } from '../utils/logger.js';
import { getLlmProvider } from '../llm/index.js';

/** Compact representation of a page sent to the LLM. */
interface PageSummary {
  pageIndex: number;
  url: string;
  title?: string;
  forms: Array<{
    formIndex: number;
    formId: string;
    method: string;
    action?: string;
    fieldNames: string[];
    fieldTypes: string[];
    labels: string[];
    submitText?: string;
  }>;
  buttons: Array<{
    buttonIndex: number;
    buttonId: string;
    text?: string;
    ariaLabel?: string;
    type: string;
    href?: string;
  }>;
  links: Array<{
    linkIndex: number;
    linkId: string;
    text?: string;
    href: string;
    isNavigation: boolean;
  }>;
}

/** Shape of the JSON response we expect from the LLM. */
interface SemanticResult {
  pages: Array<{
    pageIndex: number;
    semanticName?: string;
    description?: string;
    forms: Array<{
      formIndex: number;
      semanticName: string;
      description: string;
    }>;
    buttons: Array<{
      buttonIndex: number;
      semanticAction: string;
      description: string;
    }>;
    links: Array<{
      linkIndex: number;
      semanticAction: string;
    }>;
  }>;
}

const MAX_TOKENS = 4096;

/**
 * Enrich PageDescriptors with LLM-inferred semantic names and descriptions.
 *
 * When ANTHROPIC_API_KEY is not set, returns pages unchanged with a warning.
 */
export async function analyzeSemantics(
  pages: PageDescriptor[],
  model?: string,
): Promise<PageDescriptor[]> {
  const provider = await getLlmProvider();
  if (!provider) {
    logger.warn('No LLM provider configured — skipping semantic analysis');
    return pages;
  }

  // Build compact page summaries for the prompt
  const summaries: PageSummary[] = pages.map((page, pageIndex) => ({
    pageIndex,
    url: page.url,
    title: page.title,
    forms: page.forms.map((form, formIndex) => ({
      formIndex,
      formId: form.formId,
      method: form.method,
      action: form.action,
      fieldNames: form.fields.map((f) => f.name),
      fieldTypes: form.fields.map((f) => f.fieldType),
      labels: form.fields.map((f) => f.label ?? f.name),
      submitText: form.submitButton?.humanLabel,
    })),
    buttons: page.buttons.map((btn, buttonIndex) => ({
      buttonIndex,
      buttonId: btn.buttonId,
      text: btn.text,
      ariaLabel: btn.ariaLabel,
      type: btn.type,
      href: btn.href,
    })),
    links: page.links.map((link, linkIndex) => ({
      linkIndex,
      linkId: link.linkId,
      text: link.text,
      href: link.href,
      isNavigation: link.isNavigation,
    })),
  }));

  const prompt = `You are analyzing a website's interactive elements to generate MCP tool names. Given the page structure below, infer semantic names and descriptions for each element.

Rules:
- Form semanticName: snake_case, e.g. "login_form", "search_form", "checkout_form"
- Button semanticAction: snake_case verb, e.g. "add_to_cart", "submit_order", "toggle_menu"
- Link semanticAction: snake_case, e.g. "navigate_to_checkout", "view_product_details"
- Page semanticName: snake_case, e.g. "login_page", "product_listing"
- Descriptions: one sentence explaining what the element does
- Only output valid JSON matching the schema, no explanation

Schema:
{
  "pages": [{
    "pageIndex": number,
    "semanticName": string,
    "description": string,
    "forms": [{ "formIndex": number, "semanticName": string, "description": string }],
    "buttons": [{ "buttonIndex": number, "semanticAction": string, "description": string }],
    "links": [{ "linkIndex": number, "semanticAction": string }]
  }]
}

Pages:
${JSON.stringify(summaries, null, 2)}`;

  try {
    logger.info('Analyzing page semantics with LLM...');
    const responseText = await provider.completeText({
      prompt,
      tier: 'fast',
      model,
      maxTokens: MAX_TOKENS,
    });

    // Extract the first balanced JSON object — robust to markdown fences and
    // leading/trailing prose around the object.
    const json = extractJsonObject(responseText);
    if (json === null) {
      logger.warn('Semantic analysis returned no JSON object — using defaults');
      return pages;
    }

    const result: SemanticResult = JSON.parse(json);

    // Apply inferred names back to the page descriptors
    const enriched = pages.map((page, pageIndex) => {
      const pageResult = result.pages.find((p) => p.pageIndex === pageIndex);
      if (!pageResult) return page;

      const updatedPage: PageDescriptor = {
        ...page,
        semanticName: pageResult.semanticName ?? page.semanticName,
        description: pageResult.description ?? page.description,
      };

      updatedPage.forms = page.forms.map((form, formIndex) => {
        const formResult = pageResult.forms.find((f) => f.formIndex === formIndex);
        if (!formResult) return form;
        return {
          ...form,
          semanticName: formResult.semanticName,
          description: formResult.description,
        };
      });

      updatedPage.buttons = page.buttons.map((btn, buttonIndex) => {
        const btnResult = pageResult.buttons.find((b) => b.buttonIndex === buttonIndex);
        if (!btnResult) return btn;
        return {
          ...btn,
          semanticAction: btnResult.semanticAction,
          description: btnResult.description,
        };
      });

      updatedPage.links = page.links.map((link, linkIndex) => {
        const linkResult = pageResult.links.find((l) => l.linkIndex === linkIndex);
        if (!linkResult) return link;
        return {
          ...link,
          semanticAction: linkResult.semanticAction,
        };
      });

      return updatedPage;
    });

    const totalNamed = enriched.reduce(
      (n, p) =>
        n +
        p.forms.filter((f) => f.semanticName).length +
        p.buttons.filter((b) => b.semanticAction).length +
        p.links.filter((l) => l.semanticAction).length,
      0,
    );
    logger.info(`Semantic analysis complete: ${totalNamed} elements named`);

    return enriched;
  } catch (err) {
    logger.warn(
      `Semantic analysis failed, using defaults: ${err instanceof Error ? err.message : err}`,
    );
    return pages;
  }
}
