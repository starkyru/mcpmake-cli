import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Entry } from 'har-format';

/**
 * A4-13: the site crawler builds HAR entries during hybrid-mode capture
 * (`captureHar: true`). Those entries must be scrubbed of live credentials at
 * build time — exactly as the recorder's buildHarEntry path is — so a
 * crawl-built HAR never carries verbatim Authorization/Cookie/Set-Cookie
 * secrets even if it is persisted without going through filterHarEntries.
 *
 * We drive the REAL `crawlSite` (which calls the real `buildCrawlHarEntry` and,
 * after this fix, the real `redactEntrySecrets`) against a fake Playwright.
 * `goto` blocks until the test has emitted its request/response events, so the
 * crawler's listeners are registered first and the entry is built from events
 * carrying real secret header values. We then assert those values are gone.
 */

type Listener = (arg: unknown) => void;

class FakePage {
  private listeners = new Map<string, Listener[]>();
  /** Resolves once the test signals it has finished emitting events. */
  private gotoGate?: () => void;

  on(event: string, cb: Listener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }
  off(event: string, cb: Listener): void {
    const arr = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      arr.filter((l) => l !== cb),
    );
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(arg);
  }
  async route(): Promise<void> {}
  goto(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.gotoGate = resolve;
    });
  }
  releaseGoto(): void {
    this.gotoGate?.();
  }
  async waitForTimeout(): Promise<void> {}
  /**
   * True once the crawler has wired its HAR-capture 'response' listener AND
   * reached `goto` (so the gate exists to release). The crawler loads chromium
   * via a dynamic `import('playwright')`, so the number of async hops before
   * this point is not fixed — `tick()` polls on this, not a hardcoded count.
   */
  isReady(): boolean {
    return (this.listeners.get('response')?.length ?? 0) > 0 && this.gotoGate !== undefined;
  }
  // parsePage reads these; return an empty DOM so no per-element evaluate runs.
  url(): string {
    return 'https://example.com/';
  }
  async title(): Promise<string> {
    return 'Example';
  }
  async $$(): Promise<unknown[]> {
    return [];
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

/** A Playwright Request stand-in carrying a secret Authorization header. */
function makeRequest(headers: Record<string, string>, url = 'https://example.com/api') {
  return {
    url: () => url,
    method: () => 'GET',
    headers: () => headers,
    postData: () => undefined,
    resourceType: () => 'fetch',
  };
}

/** A Playwright Response stand-in carrying a Set-Cookie secret. */
function makeResponse(request: unknown, headers: Record<string, string>) {
  return {
    request: () => request,
    status: () => 200,
    statusText: () => 'OK',
    headers: () => headers,
    body: async () => Buffer.from('{}'),
  };
}

/**
 * Wait until the crawler has registered its HAR-capture listeners and reached
 * `goto`. Polls `fakePage.isReady()`, yielding a macrotask between checks so a
 * pending dynamic `import('playwright')` (which can settle on a macrotask) gets
 * to resolve — robust to the crawler's async hops, not a fixed microtask count.
 */
async function tick(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (fakePage.isReady()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('crawler did not register listeners / reach goto in time');
}

describe('A4-13: crawl-built HAR entries are credential-scrubbed at build time', () => {
  beforeEach(() => {
    fakePage = new FakePage();
    // The start-URL SSRF guard does a DNS lookup (a macrotask) that would
    // desync the listener-registration timing this test relies on. The escape
    // hatch short-circuits it synchronously; the URL is public anyway.
    process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
  });
  afterEach(() => {
    delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
  });

  it('redacts Authorization/Cookie request + Set-Cookie response headers', async () => {
    const { crawlSite } = await import('../../src/analyzer/site-crawler.js');

    const bearerSecret = 'sk_live_DEADBEEFsupersecret';
    const cookieSecret = 'session=TOPSECRETvalue123';
    const setCookieSecret = 'sid=RESPONSE_SECRET_abc; Path=/; HttpOnly';

    const crawlPromise = crawlSite({
      url: 'https://example.com',
      depth: 0,
      maxPages: 1,
      headless: true,
      captureScreenshots: false,
      captureHar: true,
    });
    await tick();

    const req = makeRequest({
      authorization: `Bearer ${bearerSecret}`,
      cookie: cookieSecret,
      'content-type': 'application/json',
    });
    fakePage.emit('request', req);
    fakePage.emit(
      'response',
      makeResponse(req, {
        'content-type': 'application/json',
        'set-cookie': setCookieSecret,
      }),
    );
    await tick();
    fakePage.releaseGoto();

    const result = await crawlPromise;
    const entries = result.harEntries;
    expect(entries).toBeDefined();
    expect(entries!.length).toBe(1);

    const entry = entries![0] as Entry;
    const reqHeader = (name: string) =>
      entry.request.headers.find((h) => h.name.toLowerCase() === name)?.value;
    const resHeader = (name: string) =>
      entry.response.headers.find((h) => h.name.toLowerCase() === name)?.value;

    // The verbatim secrets must be gone from every header value.
    expect(reqHeader('authorization')).toBe('Bearer <redacted>');
    expect(reqHeader('cookie')).toBe('session=<redacted>');
    // Set-Cookie keeps the cookie NAME and the trailing attributes, redacts the value.
    expect(resHeader('set-cookie')).toBe('sid=<redacted>; Path=/; HttpOnly');

    // Belt-and-braces: the raw secret substrings appear nowhere in the entry.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(bearerSecret);
    expect(serialized).not.toContain('TOPSECRETvalue123');
    expect(serialized).not.toContain('RESPONSE_SECRET_abc');

    // A non-sensitive header is untouched (redaction is targeted, not blanket).
    expect(reqHeader('content-type')).toBe('application/json');
  });
});
