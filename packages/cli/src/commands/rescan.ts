import { defineCommand } from 'citty';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { crawlSite } from '@mcpmake/core';
import { validateSelector } from '@mcpmake/core';
import { detectAuthFlow } from '@mcpmake/core';
import { generateSiteTools } from '@mcpmake/core';
import { healBrokenSelector } from '@mcpmake/core';
import { diffSiteDescriptors } from '@mcpmake/core';
import { collectLowConfidenceSelectors, summarizeRescan } from '@mcpmake/core';
import type { LowConfidenceSelector, RescanSummary, ChangeCounts } from '@mcpmake/core';
import { emitSiteProject } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { pathExists } from '@mcpmake/core';
import { apiKeyArg, applyApiKey } from './api-key.js';
import type { SiteDescriptor, SiteRegenMetadata, SiteProjectManifest } from '@mcpmake/core';

/**
 * Parse a numeric CLI flag as a non-negative integer. Rejects non-numeric /
 * negative input with a clear error instead of silently coercing it to NaN→0
 * (which would zero out crawl scope). An unset/empty flag falls back.
 */
export function parseIntFlag(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid --${flag}: "${value}" (expected a non-negative integer)`);
  }
  return n;
}

export default defineCommand({
  meta: {
    name: 'rescan',
    description:
      "Re-crawl a generated website MCP server's target, diff against the embedded snapshot, heal broken selectors, and optionally regenerate",
  },
  args: {
    project: {
      type: 'positional',
      description: 'Path to the generated site MCP server project',
      required: true,
    },
    url: {
      type: 'string',
      description: 'Override the base URL to rescan (default: from the embedded descriptor)',
    },
    depth: {
      type: 'string',
      description: 'Crawl depth (default: from the embedded descriptor)',
    },
    'max-pages': {
      type: 'string',
      description: 'Maximum pages to crawl (default: page count of the embedded descriptor)',
    },
    heal: {
      type: 'boolean',
      description: 'LLM-heal low-confidence selectors (requires ANTHROPIC_API_KEY)',
      default: true,
    },
    'api-key': apiKeyArg,
    write: {
      type: 'boolean',
      description: 'Regenerate the project in place from the new snapshot',
      default: false,
    },
    headless: {
      type: 'boolean',
      description: 'Run the crawl/heal browser headless',
      default: true,
    },
    format: {
      type: 'string',
      description: 'Output format: "text" (default) or "json"',
      default: 'text',
    },
  },
  async run({ args }) {
    applyApiKey(args);

    const projectDir = resolve(args.project);
    const descriptorPath = resolve(projectDir, 'src/site-descriptor.json');

    if (!(await pathExists(descriptorPath))) {
      return await fail(
        `No site snapshot at ${descriptorPath}. Is this a 'mcpmake from website' project?`,
      );
    }

    let oldSite: SiteDescriptor;
    try {
      oldSite = JSON.parse(await readFile(descriptorPath, 'utf-8')) as SiteDescriptor;
    } catch (err) {
      return await fail(`Failed to read site snapshot: ${descriptorPath}`, err);
    }

    const baseUrl = args.url ?? oldSite.baseUrl;
    const depth = parseIntFlag(args.depth, 'depth', oldSite.crawlDepth || 2);
    // Default with headroom so newly-added pages are still discovered (a flat
    // cap at the old page count would make rescan blind to site growth).
    const maxPages = parseIntFlag(
      args['max-pages'],
      'max-pages',
      Math.max(oldSite.pages.length * 2, oldSite.pages.length + 5, 1),
    );
    const headless = args.headless ?? true;

    logger.info(`Rescanning ${baseUrl} (depth ${depth}, max ${maxPages} pages)`);

    let newSite: SiteDescriptor;
    try {
      const result = await crawlSite({ url: baseUrl, depth, maxPages, headless });
      newSite = result.siteDescriptor;
    } catch (err) {
      return await fail(`Rescan crawl failed: ${baseUrl}`, err);
    }

    if (newSite.pages.length === 0) {
      return await fail('Rescan crawl found no pages. Check that the URL is reachable.');
    }

    // Diff bumps from the OLD snapshot version.
    newSite.version = oldSite.version;
    const result = diffSiteDescriptors(oldSite, newSite);

    // Heal the brittle (low-confidence) selectors in the fresh snapshot so the
    // regenerated server gets more stable selectors than a bare re-crawl found.
    const lows = collectLowConfidenceSelectors(newSite);
    let healedCount = 0;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (args.heal && lows.length > 0 && apiKey) {
      logger.info(`Healing ${lows.length} low-confidence selector(s)…`);
      healedCount = await healLowConfidenceSelectors(lows, headless);
      logger.info(`Healed ${healedCount}/${lows.length} selector(s)`);
    } else if (args.heal && lows.length > 0 && !apiKey) {
      logger.warn(
        `${lows.length} low-confidence selector(s) found, but ANTHROPIC_API_KEY is not set — skipping healing`,
      );
    }

    const summary = summarizeRescan(result);

    if (args.format === 'json') {
      process.stdout.write(
        JSON.stringify(
          {
            summary,
            healed: healedCount,
            lowConfidence: lows.length,
            brokenSelectors: result.brokenSelectors,
            changes: result.changes,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      printTextReport(summary, healedCount, lows.length);
    }

    if (args.write) {
      await regenerate(projectDir, result.newSiteDescriptor);
      logger.success(`Regenerated ${projectDir} (snapshot v${summary.newVersion})`);
    } else if (summary.totalChanges > 0 || healedCount > 0) {
      logger.info('');
      logger.info('Re-run with --write to regenerate the project from this snapshot.');
    }
  },
});

/**
 * Open a browser and try to heal each low-confidence selector by navigating to
 * its page, snapshotting the accessibility tree, asking the LLM for a better
 * selector, and applying it only if it actually resolves on the live page.
 * Mutates the selector objects in place (they are live references into the
 * descriptor). Returns the number of selectors healed.
 */
async function healLowConfidenceSelectors(
  lows: LowConfidenceSelector[],
  headless: boolean,
): Promise<number> {
  const byUrl = new Map<string, LowConfidenceSelector[]>();
  for (const low of lows) {
    const group = byUrl.get(low.pageUrl) ?? [];
    group.push(low);
    byUrl.set(low.pageUrl, group);
  }

  let healed = 0;
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    for (const [url, group] of byUrl) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1000);
      } catch (err) {
        logger.warn(
          `Could not load ${url} for healing: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      let tree = '';
      try {
        // Modern Playwright accessibility tree (YAML); compact and selector-friendly.
        tree = await page.locator('body').ariaSnapshot();
      } catch {
        // Fall back to an empty tree; the healer will likely return null.
      }

      for (const low of group) {
        const candidate = await healBrokenSelector(tree, low.selector, low.description);
        if (!candidate) continue;
        // Only apply selectors that actually resolve on the live page.
        const working = await validateSelector(page, candidate);
        if (working) {
          Object.assign(low.selector, candidate);
          healed += 1;
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return healed;
}

/** Regenerate the project in place from a fresh (healed) descriptor. */
async function regenerate(projectDir: string, descriptor: SiteDescriptor): Promise<void> {
  const metaPath = resolve(projectDir, 'mcpmake.site.json');
  let meta: SiteRegenMetadata;

  if (await pathExists(metaPath)) {
    meta = JSON.parse(await readFile(metaPath, 'utf-8')) as SiteRegenMetadata;
  } else {
    logger.warn('mcpmake.site.json not found — regenerating with default settings');
    meta = {
      serverName: hostToName(descriptor.baseUrl),
      serverVersion: '1.0.0',
      transport: 'stdio',
      baseUrl: descriptor.baseUrl,
      envVars: [
        {
          name: 'BASE_URL',
          description: 'Target website URL',
          required: true,
          example: descriptor.baseUrl,
        },
      ],
      browserConfig: {
        headless: true,
        idleTimeoutMs: 5 * 60 * 1000,
        viewport: { width: 1280, height: 720 },
        maxSessions: 10,
      },
    };
  }

  const authFlow = detectAuthFlow(descriptor.pages);
  if (authFlow) {
    descriptor.authFlow = authFlow;
  }

  const tools = generateSiteTools(descriptor);
  const manifest: SiteProjectManifest = {
    ...meta,
    siteDescriptor: descriptor,
    tools,
  };

  // Regenerate in place atomically and prune tool files dropped from the new
  // snapshot, so a mid-emit failure can't corrupt the project (M11) and removed
  // pages/forms don't leave stale, still-compiled tool files behind (M12).
  await emitSiteProject(manifest, {
    outputDir: projectDir,
    force: true,
    dryRun: false,
    prune: true,
  });
}

function hostToName(baseUrl: string): string {
  let host = 'site';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    // keep default
  }
  return (
    host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'site'
  );
}

function printTextReport(summary: RescanSummary, healedCount: number, lowCount: number): void {
  const line = (label: string, c: ChangeCounts): string =>
    `${label}: pages ${c.page}, forms ${c.form}, fields ${c.field}, buttons ${c.button}, links ${c.link}`;

  logger.info('');
  logger.info(`Snapshot v${summary.previousVersion} → v${summary.newVersion}`);
  logger.info(`  ${line('Added   ', summary.added)}`);
  logger.info(`  ${line('Removed ', summary.removed)}`);
  logger.info(`  ${line('Modified', summary.modified)}`);
  logger.info(`  Broken selectors (low-confidence change): ${summary.brokenSelectors}`);
  if (lowCount > 0) {
    logger.info(`  Healed selectors: ${healedCount}/${lowCount}`);
  }
  if (summary.totalChanges === 0) {
    logger.info('  No structural changes detected.');
  }
}
