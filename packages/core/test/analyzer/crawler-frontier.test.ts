import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PageDescriptor } from '../../src/types/site.js';

/**
 * L-frontier: the BFS crawl frontier must be deduped on ENQUEUE (against both
 * visited and already-queued URLs) and bounded, so an adversarial site that
 * links the same URL from every page — or links thousands of distinct URLs —
 * can't balloon the in-memory queue.
 *
 * We drive the real crawlSite against a fake Playwright page. parsePage is
 * mocked to return a controlled link graph; the SSRF guard is short-circuited.
 * We count how many times each URL is actually navigated to (page.goto) to
 * prove a repeated link is visited exactly once.
 */

const navigations: string[] = [];

function link(href: string) {
  return { href, text: href, isNavigation: true };
}

// Link graph keyed by the URL being parsed. Every page links back to a shared
// "/repeat" target and to its own URL, so naive (visited-only, on-dequeue)
// dedup would still enqueue "/repeat" once per page and balloon the queue.
const linksByUrl: Record<string, ReturnType<typeof link>[]> = {
  'https://example.com/': [
    link('https://example.com/a'),
    link('https://example.com/b'),
    link('https://example.com/repeat'),
    link('https://example.com/'), // self-link
  ],
  'https://example.com/a': [link('https://example.com/repeat'), link('https://example.com/b')],
  'https://example.com/b': [link('https://example.com/repeat'), link('https://example.com/a')],
  'https://example.com/repeat': [link('https://example.com/a'), link('https://example.com/b')],
};

class FakePage {
  private currentUrl = 'https://example.com/';
  url() {
    return this.currentUrl;
  }
  async route() {}
  on() {}
  off() {}
  async goto(url: string) {
    navigations.push(url);
    this.currentUrl = url;
  }
  async waitForTimeout() {}
  viewportSize() {
    return { width: 1280, height: 720 };
  }
}

let fakePage: FakePage;

const fakeBrowser = {
  newContext: async () => ({ newPage: async () => fakePage }),
  close: async () => {},
  on: () => {},
};

vi.mock('playwright', () => ({
  chromium: { launch: async () => fakeBrowser },
}));

// Keep isSameOrigin / navigationHopDecision real; only control parsePage.
vi.mock('../../src/analyzer/dom-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analyzer/dom-parser.js')>();
  return {
    ...actual,
    parsePage: async (page: { url: () => string }): Promise<PageDescriptor> => {
      const url = page.url();
      return {
        pageId: `page_${url}`,
        url,
        title: url,
        forms: [],
        buttons: [],
        links: linksByUrl[url] ?? [],
        analyzedAt: '2026-06-20T00:00:00.000Z',
      };
    },
  };
});

// Short-circuit the per-URL SSRF guard (DNS lookup) — all URLs here are public.
vi.mock('../../src/utils/ssrf-guard.js', () => ({
  assertPublicUrl: async () => {},
}));

describe('L-frontier: crawl queue dedup + bound', () => {
  beforeEach(() => {
    fakePage = new FakePage();
    navigations.length = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('navigates a repeated link at most once despite many inbound references', async () => {
    const { crawlSite } = await import('../../src/analyzer/site-crawler.js');

    await crawlSite({
      url: 'https://example.com/',
      depth: 3,
      maxPages: 50,
      headless: true,
      captureScreenshots: false,
    });

    const repeatVisits = navigations.filter((u) => u === 'https://example.com/repeat').length;
    expect(repeatVisits).toBe(1);

    // Every distinct URL is visited exactly once (no duplicate navigations).
    const counts = navigations.reduce<Record<string, number>>((acc, u) => {
      acc[u] = (acc[u] ?? 0) + 1;
      return acc;
    }, {});
    for (const url of Object.keys(counts)) {
      expect(counts[url]).toBe(1);
    }
    // All four reachable pages were crawled (correctness preserved).
    expect(new Set(navigations)).toEqual(
      new Set([
        'https://example.com/',
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/repeat',
      ]),
    );
  });

  it('bounds total navigations by maxPages even on a large link graph', async () => {
    // Build a fan-out graph: the root links to many distinct child URLs.
    const fanout = Array.from({ length: 500 }, (_, i) => `https://example.com/p${i}`);
    linksByUrl['https://example.com/'] = fanout.map(link);
    for (const u of fanout) linksByUrl[u] = [];

    const { crawlSite } = await import('../../src/analyzer/site-crawler.js');

    const result = await crawlSite({
      url: 'https://example.com/',
      depth: 3,
      maxPages: 10,
      headless: true,
      captureScreenshots: false,
    });

    // Never visit more than maxPages, regardless of how big the frontier is.
    expect(navigations.length).toBeLessThanOrEqual(10);
    expect(result.siteDescriptor.pages.length).toBeLessThanOrEqual(10);

    // restore for other tests
    linksByUrl['https://example.com/'] = [
      link('https://example.com/a'),
      link('https://example.com/b'),
      link('https://example.com/repeat'),
      link('https://example.com/'),
    ];
  });
});
