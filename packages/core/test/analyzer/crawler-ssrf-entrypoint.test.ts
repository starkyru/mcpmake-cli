import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * L-ssrf-crawl: the crawl/record entrypoints must refuse to drive a browser at a
 * private/loopback/link-local/metadata host. These tests call the real
 * entrypoints with such a URL and assert they reject from the SSRF guard
 * *before* a browser is ever launched.
 *
 * playwright is mocked so `chromium.launch` throws a sentinel: if the guard
 * failed to block, the rejection would carry that sentinel instead of the
 * guard's message — so a passing test proves the guard runs first.
 */

const LAUNCH_SENTINEL = '__BROWSER_LAUNCHED__';
const launchSpy = vi.fn(async () => {
  throw new Error(LAUNCH_SENTINEL);
});

vi.mock('playwright', () => ({
  chromium: { launch: launchSpy },
}));

// goal-crawler resolves a model before the URL guard; mock the SDK + resolver so
// the test never reaches the network and exercises only the guard wiring.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn() };
  },
}));
vi.mock('../../src/utils/model-resolver.js', () => ({
  resolveModel: vi.fn(async () => 'claude-test'),
}));

const PRIVATE_URLS = [
  'http://169.254.169.254/latest/meta-data/', // cloud metadata
  'http://127.0.0.1/', // loopback
  'http://localhost/', // loopback hostname
  'http://10.0.0.5/', // RFC1918
];

beforeEach(() => {
  launchSpy.mockClear();
  delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
});

afterEach(() => {
  delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
});

describe('L-ssrf-crawl: crawlSite refuses private/metadata hosts before launch', () => {
  it.each(PRIVATE_URLS)('rejects %s without launching a browser', async (url) => {
    const { crawlSite } = await import('../../src/analyzer/site-crawler.js');
    await expect(crawlSite({ url })).rejects.toThrow(/private|reserved|resolve|http\(s\)/i);
    expect(launchSpy).not.toHaveBeenCalled();
  });
});

describe('L-ssrf-crawl: recordBrowserSession refuses private/metadata hosts before launch', () => {
  it.each(PRIVATE_URLS)('rejects %s without launching a browser', async (url) => {
    const { recordBrowserSession } = await import('../../src/recorder/browser-recorder.js');
    await expect(recordBrowserSession({ url, headless: true })).rejects.toThrow(
      /private|reserved|resolve|http\(s\)/i,
    );
    expect(launchSpy).not.toHaveBeenCalled();
  });
});

describe('L-ssrf-crawl: goalDirectedCrawl refuses private/metadata hosts before launch', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });

  it.each(PRIVATE_URLS)('rejects %s without launching a browser', async (url) => {
    const { goalDirectedCrawl } = await import('../../src/analyzer/goal-crawler.js');
    await expect(goalDirectedCrawl({ url, goal: 'do a thing' })).rejects.toThrow(
      /private|reserved|resolve|http\(s\)/i,
    );
    expect(launchSpy).not.toHaveBeenCalled();
  });
});

describe('L-ssrf-crawl: escape hatch allows private hosts (still gated by launch)', () => {
  it('crawlSite proceeds to browser launch when MCPMAKE_ALLOW_PRIVATE_HOSTS=1', async () => {
    process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
    const { crawlSite } = await import('../../src/analyzer/site-crawler.js');
    // With the escape hatch the guard passes, so we reach chromium.launch — which
    // our mock makes throw the sentinel, proving we got past the host check.
    await expect(crawlSite({ url: 'http://127.0.0.1/' })).rejects.toThrow(LAUNCH_SENTINEL);
    expect(launchSpy).toHaveBeenCalledOnce();
  });
});
