/**
 * Loopback static site for the browser-crawl e2e tier (Sprint E7).
 *
 * The `from website`, `from url`, and `rescan` commands all drive a real
 * headless Chromium against a live HTTP origin. To exercise them
 * deterministically — no public network, no flaky third-party DOM — we serve a
 * tiny, fully-controlled multi-page site on `127.0.0.1:0` (an OS-assigned
 * ephemeral port). The DOM is hand-authored so the crawler's discovered
 * page/form/button/link counts are EXACT and assertable.
 *
 * Two variants are served from the same server instance:
 *
 *   - `baseline` (default): the site `from website` analyzes and that `rescan`
 *     embeds as its v1 snapshot.
 *   - `drifted`: the SAME pages/forms/buttons/links by stable identity (form
 *     action, button text, link href all unchanged) but with the high-stability
 *     selector anchors stripped (`id` / `data-testid` removed). A re-crawl then
 *     resolves those elements to a low-confidence css-path selector, so
 *     `diffSiteDescriptors` records them as `selector-broken` (brokenSelectors)
 *     — that is the structural drift `rescan` is built to surface. The drifted
 *     variant also ADDS one page (/about) + its inbound link, REMOVES one link
 *     (home's "Contact" nav link), and MODIFIES one form field (contact email
 *     flips required→optional) so the added/removed/modified change buckets are
 *     each non-empty too.
 *
 * Selector-stability facts this relies on (see analyzer/selector-builder.ts):
 *   - `data-testid` → confidence 0.95
 *   - `#id` (not auto-generated) → 0.90
 *   - `[name=...]` → 0.85
 *   - css-path fallback → 0.40   (< 0.5 ⇒ "low confidence" / broken)
 *
 * Element-discovery facts (see analyzer/dom-parser.ts):
 *   - a <form> is only counted when it has ≥1 visible (non-hidden) field.
 *   - a standalone <button> must be OUTSIDE any <form>, visible, and carry
 *     text or aria-label.
 *   - an <a href> link is counted only when it is visible, has text, and is
 *     http(s); `isNavigation` ⇔ same-origin and no `#` fragment. Links are
 *     deduplicated by normalized href PER PAGE.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Which DOM the server returns for page routes. */
export type SiteVariant = 'baseline' | 'drifted';

export interface StaticSite {
  /** Origin the CLI/crawler targets, e.g. `http://127.0.0.1:54123` (no trailing slash). */
  readonly baseUrl: string;
  /** Switch the DOM served for subsequent requests. */
  setVariant(variant: SiteVariant): void;
  /** The variant currently being served. */
  readonly variant: SiteVariant;
  /** Paths (method + path) the server has handled, for optional assertions. */
  readonly requests: ReadonlyArray<{ method: string; path: string }>;
  /** Stop the server and free the port. */
  close(): Promise<void>;
}

const htmlDoc = (title: string, body: string): string =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

// ─── Baseline DOM ───────────────────────────────────────────────────
//
// Counts the crawler discovers at depth 2 (default), max-pages 20 (verified
// against the built core):
//   pages   : 3  ( / , /search , /contact )
//   forms   : 2  (search form on / , contact form on /contact)
//   buttons : 1  (#toggle-menu on / — outside any form)
//   links   : 4  (Search + Contact on / , Home on /search , Home on /contact),
//                 all same-origin navigation links.
// → 11 MCP tools: 3 browser-lifecycle + navigate_home + 2 form tools
//   (search, subscribe) + 1 button tool + 4 link nav tools.

function homeBaseline(): string {
  return htmlDoc(
    'Home',
    `
      <h1>Acme Home</h1>
      <nav>
        <a href="/search">Search</a>
        <a href="/contact">Contact</a>
      </nav>
      <button id="toggle-menu" type="button">Toggle Menu</button>
      <form action="/search" method="get">
        <label for="q">Query</label>
        <input id="q" name="q" type="search" placeholder="Search…" />
        <button type="submit">Go</button>
      </form>
    `,
  );
}

function searchBaseline(): string {
  // A results page with NO form of its own — only the one search form on `/`
  // exists, so the two search-form tools never collide on a filename (see the
  // duplicate-filename BUG note in rescan.e2e.test.ts). Just a back-home link.
  return htmlDoc(
    'Search',
    `
      <h1>Search Results</h1>
      <nav><a href="/">Home from Search</a></nav>
    `,
  );
}

function contactBaseline(): string {
  return htmlDoc(
    'Contact',
    `
      <h1>Contact Us</h1>
      <nav><a href="/">Home from Contact</a></nav>
      <form id="contact-form" action="/api/contact" method="post">
        <label for="name">Name</label>
        <input id="name" name="name" type="text" required />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required />
        <button type="submit">Send</button>
      </form>
    `,
  );
}

// ─── Drifted DOM ────────────────────────────────────────────────────
//
// Same stable identities (form actions, button TEXTs, link HREFs) so elements
// MATCH across the diff by id — but the stable selector anchors (#id) are gone,
// dropping each matched element to a low-confidence css-path selector. The diff
// then classifies the changed-yet-matched selectors as `selector-broken`.
//
// Additionally, to populate the added/removed/modified buckets:
//   - ADD a page: /about (new link from home + new route).
//   - REMOVE a link: the home page drops its "Contact" nav link (but /contact
//     remains reachable as a page only if still linked; we keep it reachable via
//     /about so the page set's intersection is non-trivial — see note below).
//   - MODIFY a button: "Toggle Menu" → "Open Menu" (same buttonId? No — buttonId
//     is keyed on text, so a text change makes it a remove+add, NOT a modify).
//     For a true `modified` BUTTON change the buttonId must be STABLE while text
//     changes — but buttonId IS derived from text. So instead we drive a
//     `modified` FIELD change (email required → optional), which keys on the
//     stable form action + field name. We assert that bucket precisely below.

function homeDrifted(): string {
  // #toggle-menu id removed → css-path selector (low confidence) but SAME text
  // "Toggle Menu" → SAME buttonId → diff sees a selector-broken button.
  // "Contact" nav link removed; "About" nav link added.
  return htmlDoc(
    'Home',
    `
      <h1>Acme Home</h1>
      <nav>
        <a href="/search">Search</a>
        <a href="/about">About</a>
      </nav>
      <button type="button">Toggle Menu</button>
      <form action="/search" method="get">
        <label for="q">Query</label>
        <input name="q" type="search" placeholder="Search…" />
        <button type="submit">Go</button>
      </form>
    `,
  );
}

function searchDrifted(): string {
  // Mirrors searchBaseline: a form-free results page.
  return htmlDoc(
    'Search',
    `
      <h1>Search Results</h1>
      <nav><a href="/">Home from Search</a></nav>
    `,
  );
}

function contactDrifted(): string {
  // #contact-form id and the email "required" attribute removed. Form action is
  // unchanged → same formId → its selector drops to css-path (broken), and the
  // email field's required flag flips true→false → a `modified` FIELD change.
  return htmlDoc(
    'Contact',
    `
      <h1>Contact Us</h1>
      <nav><a href="/">Home from Contact</a></nav>
      <form action="/api/contact" method="post">
        <label for="name">Name</label>
        <input name="name" type="text" required />
        <label for="email">Email</label>
        <input name="email" type="email" />
        <button type="submit">Send</button>
      </form>
    `,
  );
}

function aboutDrifted(): string {
  // New page reachable from the drifted home nav. Links back to /contact so the
  // contact page stays in the crawl set across both variants.
  return htmlDoc(
    'About',
    `
      <h1>About</h1>
      <nav>
        <a href="/">Home from About</a>
        <a href="/contact">Contact from About</a>
      </nav>
    `,
  );
}

// ─── App page for the `from url` recorder path ──────────────────────
//
// `from url --headless` records network traffic, not DOM. This page, on load,
// issues a same-origin `fetch` to `/api/widgets` carrying a Bearer header, so
// the recorder captures an authenticated API call → the generated server
// detects `bearer` auth and seeds a `BEARER_TOKEN` env var. The page is served
// under BOTH variants (the recorder path is variant-agnostic).
function appPage(): string {
  return htmlDoc(
    'App',
    `
      <h1>App Dashboard</h1>
      <script>
        // Fire one authenticated API call on load so the headless recorder has
        // traffic to cluster into a tool and an Authorization header to detect.
        fetch('/api/widgets', { headers: { 'Authorization': 'Bearer e2e-recorder-token' } })
          .catch(function () {});
      </script>
    `,
  );
}

function pageFor(variant: SiteVariant, path: string): string | undefined {
  // The recorder app page is served regardless of variant.
  if (path === '/app') return appPage();
  if (variant === 'baseline') {
    if (path === '/' || path === '') return homeBaseline();
    if (path === '/search') return searchBaseline();
    if (path === '/contact') return contactBaseline();
    return undefined;
  }
  // drifted
  if (path === '/' || path === '') return homeDrifted();
  if (path === '/search') return searchDrifted();
  if (path === '/contact') return contactDrifted();
  if (path === '/about') return aboutDrifted();
  return undefined;
}

/**
 * Start the static site on loopback with an ephemeral port. Resolves once it is
 * listening. Always `close()` it in a `finally`/`afterAll`.
 *
 * The `/api/contact` POST endpoint is a same-origin JSON API (so `from url`
 * --navigate can record an API call against it and so the contact form is a
 * realistic API-backed form for hybrid scenarios).
 */
export async function startStaticSite(initial: SiteVariant = 'baseline'): Promise<StaticSite> {
  let variant: SiteVariant = initial;
  const requests: { method: string; path: string }[] = [];

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    requests.push({ method, path });

    // Same-origin JSON API: POST /api/contact → { ok: true }.
    if (path === '/api/contact') {
      if (method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, received: chunks.length > 0 }));
        });
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    // Same-origin JSON read endpoints the recorder path (`from url`) clusters
    // into tools. `/api/widgets` is the one `/app` fetches with a Bearer header;
    // `/api/orders` is an additional navigate target so the recorder yields two
    // distinct operations.
    if (path === '/api/widgets') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: 1, name: 'widget-a' },
          { id: 2, name: 'widget-b' },
        ]),
      );
      return;
    }
    if (path === '/api/orders') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ orders: [] }));
      return;
    }

    const body = pageFor(variant, path);
    if (body === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    setVariant(v: SiteVariant) {
      variant = v;
    },
    get variant() {
      return variant;
    },
    get requests() {
      return requests;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
