/**
 * Sprint E7 — `mcpmake rescan` end-to-end (real headless re-crawl + diff + heal).
 *
 * Gated behind BOTH `MCPMAKE_E2E=1` and `MCPMAKE_E2E_BROWSER=1`. The flow:
 *   1. `from website` against the BASELINE static site → a generated site
 *      project with an embedded v1 `src/site-descriptor.json`.
 *   2. Switch the same loopback server to its DRIFTED variant (selectors
 *      stripped, a page/link added, a link removed, a field flipped).
 *   3. `rescan` re-crawls, diffs, and (optionally) heals.
 *
 * The DRIFTED variant is engineered (see helpers/static-site.ts) so the diff is
 * EXACT and assertable: added {page:1, link:1}, removed {link:1},
 * modified {field:1}, brokenSelectors:2 (the `#toggle-menu` button and the
 * `#contact-form` form, both stable by identity but dropped to a low-confidence
 * css-path selector). Verified against the built core.
 *
 * Heal gating: with no LLM key, low-confidence selectors are reported but NOT
 * healed ("skipping healing", healedCount 0). With a mock LLM (helpers/mock-llm),
 * the healer applies a candidate ONLY if it resolves on the live page — proven
 * here by a non-resolving candidate (healed 0) vs. a resolving one (healed > 0).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { E2E, E2E_BROWSER } from './helpers/gating.js';
import { ensureChromium, browserEnv } from './helpers/browser-env.js';
import { startStaticSite, type StaticSite } from './helpers/static-site.js';
import { startMockLlm, mockLlmEnv, type MockLlm } from './helpers/mock-llm.js';

const NAME = 'acme-site';

let chromiumOk = false;

/** Parse the single JSON object `rescan --format json` writes to stdout. */
interface RescanJson {
  summary: {
    previousVersion: number;
    newVersion: number;
    added: Record<string, number>;
    removed: Record<string, number>;
    modified: Record<string, number>;
    brokenSelectors: number;
    totalChanges: number;
  };
  healed: number;
  lowConfidence: number;
  brokenSelectors: Array<{ toolName: string; selector: { primary: string } }>;
  changes: Array<{ changeType: string; elementType: string; description: string }>;
}

function parseRescanJson(stdout: string): RescanJson {
  // rescan writes the JSON object first via process.stdout.write, then the
  // consola "Re-run with --write" hint. Slice from the first `{` to its match.
  const start = stdout.indexOf('{');
  if (start === -1) throw new Error(`no JSON in rescan stdout:\n${stdout}`);
  const m = stdout.slice(start).match(/[\s\S]*?\n}\n/);
  if (!m) throw new Error(`could not isolate rescan JSON:\n${stdout}`);
  return JSON.parse(m[0]) as RescanJson;
}

/**
 * Generate a fresh baseline site project into `out`. The server must be on the
 * BASELINE variant when called. Returns nothing; asserts the generate succeeded.
 */
async function generateBaseline(site: StaticSite, cwd: string, out: string): Promise<void> {
  const r = await runCli(
    ['from', 'website', site.baseUrl, '-o', out, '--name', NAME, '--headless'],
    { cwd, env: browserEnv(), timeoutMs: 90_000 },
  );
  expect(r.code).toBe(0);
  expect(existsSync(join(out, 'src/site-descriptor.json'))).toBe(true);
}

describe.skipIf(!E2E || !E2E_BROWSER)('e2e (browser): rescan', () => {
  let site: StaticSite;

  beforeAll(async () => {
    ensureBuilt();
    chromiumOk = ensureChromium();
    site = await startStaticSite('baseline');
  });

  afterAll(async () => {
    await site?.close();
  });

  it('detects the drift: exact added/removed/modified + brokenSelectors (heal off)', async () => {
    if (!chromiumOk) {
      console.warn('SKIP: chromium not available (offline) — nightly CI provisions it.');
      return;
    }

    await withTempDir(async (dir) => {
      const proj = join(dir, 'proj');
      site.setVariant('baseline');
      await generateBaseline(site, dir, proj);

      // Drift the live site, then rescan (no LLM key, heal explicitly off).
      site.setVariant('drifted');
      const r = await runCli(['rescan', proj, '--heal=false', '--format', 'json', '--headless'], {
        cwd: dir,
        env: browserEnv(),
        timeoutMs: 90_000,
      });
      expect(r.code).toBe(0);

      const out = parseRescanJson(r.stdout);
      expect(out.summary.previousVersion).toBe(1);
      expect(out.summary.newVersion).toBe(2);
      // Exact per-kind change buckets engineered by the drifted variant.
      expect(out.summary.added).toMatchObject({ page: 1, link: 1, form: 0, button: 0, field: 0 });
      expect(out.summary.removed).toMatchObject({ link: 1, page: 0, form: 0, button: 0, field: 0 });
      expect(out.summary.modified).toMatchObject({
        field: 1,
        page: 0,
        form: 0,
        button: 0,
        link: 0,
      });
      expect(out.summary.brokenSelectors).toBe(2);
      expect(out.summary.totalChanges).toBe(6);

      // The two broken selectors are exactly the stripped #id anchors.
      const broken = out.brokenSelectors.map((b) => b.selector.primary).sort();
      expect(broken).toEqual(['#contact-form', '#toggle-menu']);

      // Heal was off → nothing healed, but low-confidence selectors were counted.
      expect(out.healed).toBe(0);
      expect(out.lowConfidence).toBeGreaterThan(0);

      // The change descriptions confirm the specific drift, not just counts.
      const descs = out.changes.map((c) => `${c.changeType}/${c.elementType}`);
      expect(descs).toContain('added/page');
      expect(descs).toContain('removed/link');
      expect(descs).toContain('modified/field');
      expect(descs.filter((d) => d === 'selector-broken/form')).toHaveLength(1);
      expect(descs.filter((d) => d === 'selector-broken/button')).toHaveLength(1);
    });
  });

  it('--write regenerates a COPY (snapshot v1→v2) and leaves the original untouched', async () => {
    if (!chromiumOk) {
      console.warn('SKIP: chromium not available (offline) — nightly CI provisions it.');
      return;
    }

    await withTempDir(async (dir) => {
      const original = join(dir, 'original');
      site.setVariant('baseline');
      await generateBaseline(site, dir, original);

      // Operate on a COPY so the original snapshot is provably never mutated.
      const copy = join(dir, 'copy');
      cpSync(original, copy, { recursive: true });
      const originalDescriptor = join(original, 'src/site-descriptor.json');
      const copyDescriptor = join(copy, 'src/site-descriptor.json');
      expect(readVersion(originalDescriptor)).toBe(1);
      expect(readVersion(copyDescriptor)).toBe(1);

      site.setVariant('drifted');
      const r = await runCli(['rescan', copy, '--heal=false', '--write', '--headless'], {
        cwd: dir,
        env: browserEnv(),
        timeoutMs: 90_000,
      });
      expect(r.code).toBe(0);
      const text = combined(r);
      expect(text).toContain('Snapshot v1 → v2');
      expect(text).toContain(`Regenerated ${copy}`);

      // The copy's embedded snapshot bumped to v2; the original is unchanged.
      expect(readVersion(copyDescriptor)).toBe(2);
      expect(readVersion(originalDescriptor)).toBe(1);
    });
  });

  it('no key + heal-on reports low-confidence selectors but skips healing (healed 0)', async () => {
    if (!chromiumOk) {
      console.warn('SKIP: chromium not available (offline) — nightly CI provisions it.');
      return;
    }

    await withTempDir(async (dir) => {
      const proj = join(dir, 'proj');
      site.setVariant('baseline');
      await generateBaseline(site, dir, proj);

      // heal defaults to true; the scrubbed env has NO ANTHROPIC_API_KEY.
      site.setVariant('drifted');
      const r = await runCli(['rescan', proj, '--format', 'json', '--headless'], {
        cwd: dir,
        env: browserEnv(),
        timeoutMs: 90_000,
      });
      expect(r.code).toBe(0);
      const text = combined(r);
      // Exact warn line from rescan.ts when the active provider key is absent.
      expect(text).toContain('low-confidence selector(s) found, but ANTHROPIC_API_KEY is not set');
      expect(text).toContain('skipping healing');

      const out = parseRescanJson(r.stdout);
      expect(out.healed).toBe(0);
      expect(out.lowConfidence).toBeGreaterThan(0);
    });
  });

  it('heal-on (mock LLM) increments healedCount ONLY for selectors that resolve', async () => {
    if (!chromiumOk) {
      console.warn('SKIP: chromium not available (offline) — nightly CI provisions it.');
      return;
    }

    let mock: MockLlm | undefined;
    try {
      mock = await startMockLlm();
      const llmEnv = browserEnv(mockLlmEnv(mock));

      await withTempDir(async (dir) => {
        const proj = join(dir, 'proj');
        site.setVariant('baseline');
        await generateBaseline(site, dir, proj);
        site.setVariant('drifted');

        // CASE A: the LLM returns a structurally-valid selector that does NOT
        // resolve on the live page → validateSelector rejects it → healed 0.
        // This proves the healer's validation gate, not just "LLM responded".
        mock!.setChatContent(
          JSON.stringify({
            primary: '#definitely-not-on-this-page',
            fallbacks: [],
            strategy: 'id',
            confidence: 0.9,
            humanLabel: 'phantom',
          }),
        );
        const a = await runCli(['rescan', proj, '--format', 'json', '--headless'], {
          cwd: dir,
          env: llmEnv,
          timeoutMs: 90_000,
        });
        expect(a.code).toBe(0);
        const ja = parseRescanJson(a.stdout);
        expect(ja.lowConfidence).toBeGreaterThan(0);
        expect(ja.healed).toBe(0);

        // CASE B: the LLM returns a selector that DOES resolve (`body` exists on
        // every page) → the healer validates and applies it → healed > 0.
        mock!.setChatContent(
          JSON.stringify({
            primary: 'body',
            fallbacks: [],
            strategy: 'css-path',
            confidence: 0.6,
            humanLabel: 'page body',
          }),
        );
        const b = await runCli(['rescan', proj, '--format', 'json', '--headless'], {
          cwd: dir,
          env: llmEnv,
          timeoutMs: 90_000,
        });
        expect(b.code).toBe(0);
        const jb = parseRescanJson(b.stdout);
        expect(jb.lowConfidence).toBe(ja.lowConfidence);
        expect(jb.healed).toBeGreaterThan(0);
        // Every resolvable low-confidence selector heals once the candidate validates.
        expect(jb.healed).toBe(jb.lowConfidence);
        // The mock actually served the heal prompts (one chat call per low selector).
        expect(mock!.chatRequests().length).toBeGreaterThan(0);
      });
    } finally {
      await mock?.close();
    }
  });

  // BUG (E7): `rescan --write` crashes (exit 1, ENOENT during atomic rename)
  // whenever two distinct site tools resolve to the SAME generated filename.
  // The site tool-generator de-duplicates tool *names* (`navigate_to_home`,
  // `navigate_to_home_2`) but derives `fileName`/`functionName` from the
  // *pre-dedup* raw name, so two links/forms with identical text collapse onto
  // one `src/tools/<name>.ts`. The force/atomic writer (emitter/code-writer.ts)
  // then stages that path once but tries to `rename` it twice → the second
  // rename hits ENOENT (the temp was consumed by the first). Two ordinary
  // "Home" links across pages are enough to trigger it. Asserted here against
  // ACTUAL behavior so the suite stays green; see "BUGS FOUND" in the report.
  it('BUG: --write crashes on duplicate tool filenames (two same-text links)', async () => {
    if (!chromiumOk) {
      console.warn('SKIP: chromium not available (offline) — nightly CI provisions it.');
      return;
    }

    const dup = await startDupLinkSite();
    try {
      await withTempDir(async (dir) => {
        const proj = join(dir, 'proj');
        const g = await runCli(
          ['from', 'website', dup.baseUrl, '-o', proj, '--name', 'dup-site', '--headless'],
          { cwd: dir, env: browserEnv(), timeoutMs: 90_000 },
        );
        // The initial (non-force) emit tolerates the collision by skip-existing,
        // so generation itself succeeds.
        expect(g.code).toBe(0);

        // rescan --write uses the force/atomic+prune path, which double-renames
        // the collided temp file and crashes.
        const r = await runCli(['rescan', proj, '--heal=false', '--write', '--headless'], {
          cwd: dir,
          env: browserEnv(),
          timeoutMs: 90_000,
        });
        expect(r.code).toBe(1);
        const text = combined(r);
        expect(text).toContain('ENOENT');
        expect(text).toContain('.mcpmake-tmp');
      });
    } finally {
      await dup.close();
    }
  });
});

/** Read the `version` field from a generated `site-descriptor.json`. */
function readVersion(descriptorPath: string): number {
  return (JSON.parse(readFileSync(descriptorPath, 'utf8')) as { version: number }).version;
}

/**
 * Minimal loopback site whose two pages each carry a link with the SAME visible
 * text ("Home"), forcing two distinct link tools onto one generated filename —
 * the precondition for the `--write` duplicate-filename crash documented above.
 */
async function startDupLinkSite(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const doc = (title: string, body: string) =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const pages: Record<string, () => string> = {
    '/': () => doc('Home', `<h1>Home</h1><nav><a href="/a">Alpha</a><a href="/b">Beta</a></nav>`),
    // Both /a and /b link back with the identical text "Home" → identical tool
    // filename `navigate-to-home.ts`.
    '/a': () => doc('Alpha', `<h1>Alpha</h1><nav><a href="/">Home</a></nav>`),
    '/b': () => doc('Beta', `<h1>Beta</h1><nav><a href="/">Home</a></nav>`),
  };
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const fn = pages[path];
    if (!fn) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fn());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
