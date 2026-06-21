import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * L-pending: the recorder tracks in-flight requests in a Map and previously
 * only freed an entry when a MATCHING 'response' arrived. Requests that fail or
 * finish without a captured response (aborted, blocked, timed out, redirect)
 * leaked their entries forever.
 *
 * These tests drive the recorder against a fake Playwright page that exposes
 * its registered listeners, emit terminal events ('requestfailed' /
 * 'requestfinished') with no matching 'response', and assert the produced
 * session is consistent (no entry captured) — i.e. the terminal-event handlers
 * are wired and run. The off()-on-disconnect path is exercised by close().
 */

type Listener = (arg: unknown) => void;

class FakePage {
  listeners = new Map<string, Listener[]>();
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
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(arg);
  }
  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }
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
   * True once the recorder has wired its 'response' listener AND reached `goto`
   * (so the gate exists to release). The recorder loads chromium via a dynamic
   * `import('playwright')`, so the number of async hops before this is reached
   * is not fixed — `tick()` polls on this rather than a hardcoded count.
   */
  isReady(): boolean {
    return this.listenerCount('response') > 0 && this.gotoGate !== undefined;
  }
}

let fakePage: FakePage;
let disconnectCb: (() => void) | undefined;

const fakeBrowser = {
  newContext: async () => ({ newPage: async () => fakePage }),
  close: async () => {
    disconnectCb?.();
  },
  on: (event: string, cb: () => void) => {
    if (event === 'disconnected') disconnectCb = cb;
  },
};

vi.mock('playwright', () => ({
  chromium: { launch: async () => fakeBrowser },
}));

function makeRequest(url = 'https://example.com/api') {
  return {
    url: () => url,
    method: () => 'GET',
    headers: () => ({}),
    postData: () => undefined,
    resourceType: () => 'fetch',
  };
}

/**
 * A minimal fake Playwright Response. `body()` resolves to a tiny readable JSON
 * payload so the recorder takes its normal capture path and appends an entry —
 * provided the request is still tracked in pendingRequests when it arrives.
 */
function makeResponse(request: unknown, url = 'https://example.com/api') {
  return {
    request: () => request,
    url: () => url,
    status: () => 200,
    statusText: () => 'OK',
    headers: () => ({ 'content-type': 'application/json', 'content-length': '2' }),
    body: async () => Buffer.from('{}'),
  };
}

/**
 * Wait until the recorder has wired its listeners and reached `goto`. Polls
 * `fakePage.isReady()`, yielding a macrotask between checks so a pending dynamic
 * `import('playwright')` (which can settle on a macrotask) gets to resolve —
 * robust to the recorder's async hops rather than a fixed microtask count.
 */
async function tick(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (fakePage.isReady()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('recorder did not register listeners / reach goto in time');
}

describe('L-pending: recorder frees pending entries on terminal events', () => {
  beforeEach(() => {
    fakePage = new FakePage();
    disconnectCb = undefined;
    process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
  });
  afterEach(() => {
    delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
  });

  it('captures exactly one entry when a tracked request gets a readable response (positive baseline)', async () => {
    // Anchors the discriminating tests below: the capture pipeline DOES produce
    // an entry on the happy path, so a "0 entries" result elsewhere is a real
    // signal that the response was dropped — not a dead/no-op pipeline.
    const { recordBrowserSession } = await import('../../src/recorder/browser-recorder.js');

    const sessionPromise = recordBrowserSession({ url: 'https://example.com', headless: true });
    await tick();

    const req = makeRequest('https://example.com/api/ok');
    fakePage.emit('request', req);
    fakePage.emit('response', makeResponse(req, 'https://example.com/api/ok'));

    await tick();
    fakePage.releaseGoto();

    const result = await sessionPromise;
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].request.url).toBe('https://example.com/api/ok');
    expect(result.entries[0].response.status).toBe(200);
  });

  it("'requestfailed' frees the pending entry so a late response for it is dropped", async () => {
    // Discriminating against onSettled becoming a no-op (the leak this guards):
    // onResponse early-returns when the request is no longer in pendingRequests
    // (`if (!pending) return;`). So if 'requestfailed' really deleted the entry,
    // a subsequent 'response' for the SAME request must be IGNORED. If onSettled
    // were gutted, the entry would still be tracked and this response would
    // produce a captured entry — making this assertion fail. The positive
    // baseline above proves a response on a still-tracked request DOES capture,
    // so the 0 here is attributable to the cleanup, not a broken pipeline.
    const { recordBrowserSession } = await import('../../src/recorder/browser-recorder.js');

    const sessionPromise = recordBrowserSession({ url: 'https://example.com', headless: true });
    await tick();

    // Terminal handlers must be wired so failed/finished requests are freed.
    expect(fakePage.listenerCount('requestfailed')).toBe(1);
    expect(fakePage.listenerCount('requestfinished')).toBe(1);

    const failed = makeRequest('https://example.com/aborted');
    fakePage.emit('request', failed);
    fakePage.emit('requestfailed', failed); // onSettled deletes it from pendingRequests
    // A late/duplicate 'response' arrives for the now-untracked request; it must
    // be dropped because the pending entry was already freed.
    fakePage.emit('response', makeResponse(failed, 'https://example.com/aborted'));

    await tick();
    fakePage.releaseGoto();

    const result = await sessionPromise;
    expect(result.entries.length).toBe(0);
  });

  it("'requestfinished' frees the pending entry so a late response for it is dropped", async () => {
    // Same discriminating shape as above, exercising the other terminal event.
    // A redirect/finished request whose entry is freed must not be revived by a
    // trailing 'response'.
    const { recordBrowserSession } = await import('../../src/recorder/browser-recorder.js');

    const sessionPromise = recordBrowserSession({ url: 'https://example.com', headless: true });
    await tick();

    expect(fakePage.listenerCount('requestfinished')).toBe(1);

    const finished = makeRequest('https://example.com/redirect');
    fakePage.emit('request', finished);
    fakePage.emit('requestfinished', finished); // onSettled deletes it from pendingRequests
    fakePage.emit('response', makeResponse(finished, 'https://example.com/redirect'));

    await tick();
    fakePage.releaseGoto();

    const result = await sessionPromise;
    expect(result.entries.length).toBe(0);
  });

  it('removes all listeners when the browser disconnects (no listener leak)', async () => {
    const { recordBrowserSession } = await import('../../src/recorder/browser-recorder.js');

    const sessionPromise = recordBrowserSession({ url: 'https://example.com', headless: true });
    await tick();

    expect(fakePage.listenerCount('request')).toBe(1);
    expect(fakePage.listenerCount('response')).toBe(1);

    fakePage.releaseGoto();
    await sessionPromise; // headless path calls browser.close() -> disconnect

    // Every listener the recorder added is gone after the session ends.
    expect(fakePage.listenerCount('request')).toBe(0);
    expect(fakePage.listenerCount('response')).toBe(0);
    expect(fakePage.listenerCount('requestfailed')).toBe(0);
    expect(fakePage.listenerCount('requestfinished')).toBe(0);
  });
});
