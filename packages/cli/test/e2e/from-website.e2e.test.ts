/**
 * Sprint E7 — `mcpmake from website` end-to-end (real headless Chromium crawl).
 *
 * Gated behind BOTH `MCPMAKE_E2E=1` and `MCPMAKE_E2E_BROWSER=1`: it launches a
 * real browser, which the fast/PR tiers must never pay for. It crawls the
 * loopback static site from `helpers/static-site.ts` and asserts the EXACT
 * page/form/button/link counts the analyzer discovers, the EXACT generated tool
 * count, the emitted `src/site-descriptor.json` shape, and the goal-crawl
 * hard-fail when no LLM key is configured.
 *
 * Counts are not guessed — they are the values a real crawl of the baseline DOM
 * produces (verified against the built core): 3 pages, 2 forms (a search form on
 * `/`, a contact form on `/contact`), 1 standalone button, 4 navigation links →
 * 11 MCP tools (3 browser-lifecycle + navigate_home + 2 form tools + 1 button
 * tool + 4 link tools).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { E2E, E2E_BROWSER } from './helpers/gating.js';
import { ensureChromium, browserEnv } from './helpers/browser-env.js';
import { startStaticSite, type StaticSite } from './helpers/static-site.js';

const NAME = 'acme-site';

/** Top-level keys of the embedded SiteDescriptor (verified against a real crawl). */
const DESCRIPTOR_KEYS = [
  'analyzedAt',
  'baseUrl',
  'crawlDepth',
  'metadata',
  'pages',
  'siteId',
  'version',
] as const;

// Whether chromium could be provisioned. Resolved in beforeAll; when false the
// per-test guards skip with a clear message instead of failing offline.
let chromiumOk = false;

describe.skipIf(!E2E || !E2E_BROWSER)('e2e (browser): from website', () => {
  let site: StaticSite;

  beforeAll(async () => {
    ensureBuilt();
    chromiumOk = ensureChromium();
    site = await startStaticSite('baseline');
  });

  afterAll(async () => {
    await site?.close();
  });

  it('crawls the static site → exact element counts, 11 tools, descriptor emitted', async () => {
    if (!chromiumOk) {
      console.warn('SKIP: chromium not available (offline) — nightly CI provisions it.');
      return;
    }

    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'website', site.baseUrl, '-o', out, '--name', NAME, '--headless'],
        { cwd: dir, env: browserEnv(), timeoutMs: 90_000 },
      );

      expect(r.code).toBe(0);
      const text = combined(r);

      // Exact discovery line emitted by from/website.ts after the crawl.
      expect(text).toContain('Discovered: 3 pages, 2 forms, 1 buttons, 4 links');
      // Deterministic tool total: 3 lifecycle + navigate_home + 2 forms + 1 button + 4 links.
      expect(text).toContain('Generated 11 MCP tools');
      expect(text).toContain('Pages analyzed: 3');
      expect(text).toContain('Tools generated: 11');
      // The search form on `/` → "search"; the contact form (name+email, no
      // password) infers the "subscribe" name; the standalone button →
      // click_toggle_menu.
      expect(text).toContain('search [page-action]');
      expect(text).toContain('subscribe [page-action]');
      expect(text).toContain('click_toggle_menu [element-action]');

      // The embedded snapshot exists with the expected top-level keys.
      const descriptorPath = join(out, 'src/site-descriptor.json');
      expect(existsSync(descriptorPath)).toBe(true);
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(Object.keys(descriptor).sort()).toEqual([...DESCRIPTOR_KEYS]);

      // The descriptor's content matches what the crawl discovered.
      const pages = descriptor.pages as Array<{
        url: string;
        forms: unknown[];
        buttons: unknown[];
        links: unknown[];
      }>;
      expect(pages).toHaveLength(3);
      const totalForms = pages.reduce((n, p) => n + p.forms.length, 0);
      const totalButtons = pages.reduce((n, p) => n + p.buttons.length, 0);
      const totalLinks = pages.reduce((n, p) => n + p.links.length, 0);
      expect(totalForms).toBe(2);
      expect(totalButtons).toBe(1);
      expect(totalLinks).toBe(4);
      expect(descriptor.baseUrl).toBe(site.baseUrl);
      expect(descriptor.version).toBe(1);

      // Regeneration metadata for `rescan` is written at the project root.
      expect(existsSync(join(out, 'mcpmake.site.json'))).toBe(true);
      // One tool file per generated tool name (sampling the derived names).
      expect(existsSync(join(out, 'src/tools/click-toggle-menu.ts'))).toBe(true);
      expect(existsSync(join(out, 'src/tools/subscribe.ts'))).toBe(true);
    });
  });

  it('--goal with no LLM key hard-fails before launching a crawl', async () => {
    if (!chromiumOk) {
      console.warn('SKIP: chromium not available (offline) — nightly CI provisions it.');
      return;
    }

    await withTempDir(async (dir) => {
      const out = join(dir, 'goal-out');
      // No ANTHROPIC_API_KEY/OPENAI_API_KEY in the scrubbed env → goalDirectedCrawl
      // calls requireLlmProvider, which throws the exact message asserted here.
      const r = await runCli(
        ['from', 'website', site.baseUrl, '-o', out, '--headless', '--goal', 'book a flight'],
        { cwd: dir, env: browserEnv(), timeoutMs: 60_000 },
      );

      expect(r.code).toBe(1);
      const text = combined(r);
      expect(text).toContain('goal-directed crawl (--goal) requires an LLM provider');
      expect(text).toContain('Set ANTHROPIC_API_KEY');
      // Nothing should have been emitted on the hard-fail path.
      expect(existsSync(join(out, 'src/site-descriptor.json'))).toBe(false);
    });
  });
});
