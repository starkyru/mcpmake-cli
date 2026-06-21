/**
 * Sprint E7 — `mcpmake from url` end-to-end (real headless browser recording).
 *
 * `from url` drives a real browser and records its network traffic (a HAR),
 * then runs the shared HAR pipeline (filter → normalize → dedup → cluster →
 * operations → tools) and detects auth from the captured headers. Gated behind
 * BOTH `MCPMAKE_E2E=1` and `MCPMAKE_E2E_BROWSER=1`.
 *
 * The loopback `/app` page fetches `/api/widgets` with a `Bearer` header on
 * load; `--navigate /api/orders` adds a second same-origin endpoint. A headless
 * recording therefore clusters into exactly 2 operations → 2 tools, and the
 * bearer header is detected → `BEARER_TOKEN` seeded. (The "N total requests"
 * count varies with incidental traffic like favicon, so we assert the stable
 * clustered/tool/auth lines, not the raw capture count.)
 *
 * NOTE: the remote-spec path (`from openapi <local-url>`) is net-free and lives
 * in a different sprint — it is intentionally NOT covered here.
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

const NAME = 'app-srv';

let chromiumOk = false;

describe.skipIf(!E2E || !E2E_BROWSER)('e2e (browser): from url', () => {
  let site: StaticSite;

  beforeAll(async () => {
    ensureBuilt();
    chromiumOk = ensureChromium();
    site = await startStaticSite('baseline');
  });

  afterAll(async () => {
    await site?.close();
  });

  it('records a HAR headlessly → 2 operations, 2 tools, bearer auth detected', async () => {
    if (!chromiumOk) {
      console.warn('SKIP: chromium not available (offline) — nightly CI provisions it.');
      return;
    }

    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      // Open /app (its on-load fetch carries the Bearer header) and auto-visit
      // /api/orders to surface a second operation. --resource-names keeps tool
      // names deterministic and offline (POST/GET resource-tree naming).
      const r = await runCli(
        [
          'from',
          'url',
          `${site.baseUrl}/app`,
          '-o',
          out,
          '--name',
          NAME,
          '--headless',
          '--navigate',
          '/api/orders',
          '--resource-names',
        ],
        { cwd: dir, env: browserEnv(), timeoutMs: 90_000 },
      );

      expect(r.code).toBe(0);
      const text = combined(r);

      // Deterministic pipeline outcome: the widgets + orders endpoints cluster
      // into 2 operations → 2 tools, with the Bearer header detected.
      expect(text).toContain('Clustered into 2 operations');
      expect(text).toContain('Tools generated: 2');
      expect(text).toContain('Auth detected: bearer');

      // Bearer detection seeds BEARER_TOKEN in .env.example and emits auth.ts.
      expect(existsSync(join(out, 'src/auth.ts'))).toBe(true);
      expect(readFileSync(join(out, '.env.example'), 'utf8')).toContain('BEARER_TOKEN=');

      // Exactly two tool files (plus the index), named off the REST resource tree
      // (GET /api/widgets → list-api-widgets, GET /api/orders → list-api-orders).
      expect(existsSync(join(out, 'src/tools/list-api-widgets.ts'))).toBe(true);
      expect(existsSync(join(out, 'src/tools/list-api-orders.ts'))).toBe(true);
      // The browser recorder produces an HTTP (not Playwright/site) project, so
      // no site-descriptor.json is emitted here.
      expect(existsSync(join(out, 'src/site-descriptor.json'))).toBe(false);
    });
  });

  it('headless capture with no triggered API calls hard-fails with the navigate hint', async () => {
    if (!chromiumOk) {
      console.warn('SKIP: chromium not available (offline) — nightly CI provisions it.');
      return;
    }

    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      // The home page (`/`) issues no API calls and we pass no --navigate, so the
      // recorder captures nothing API-shaped → the command fails with the exact
      // headless-mode hint from from/url.ts.
      const r = await runCli(
        ['from', 'url', site.baseUrl, '-o', out, '--name', NAME, '--headless'],
        { cwd: dir, env: browserEnv(), timeoutMs: 60_000 },
      );

      expect(r.code).toBe(1);
      const text = combined(r);
      expect(text).toContain('No API requests captured');
      expect(text).toContain('Pass --navigate');
      expect(existsSync(out)).toBe(false);
    });
  });
});
