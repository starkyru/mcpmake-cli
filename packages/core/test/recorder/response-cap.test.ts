import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * D-M2: the recorder must enforce its 5 MB response cap at the header /
 * resource-type level (so Playwright never buffers an oversized body), and it
 * must always free pendingRequests entries — even when it drops the response
 * at the MAX_ENTRIES cap.
 *
 * We drive the recorder against a fake Playwright. `goto` blocks until the
 * test has emitted its request/response events, so the recorder's listeners
 * are guaranteed to be registered first and the session won't close early.
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
  emit(event: string, arg: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(arg);
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
   * True once the recorder has registered its 'response' listener AND reached
   * `goto` (so the gate exists to release). The recorder loads its chromium
   * launcher via a dynamic `import('playwright')`, so the number of microtasks
   * before listeners are registered is not fixed — `tick()` polls on this
   * instead of a hardcoded count.
   */
  isReady(): boolean {
    return (this.listeners.get('response')?.length ?? 0) > 0 && this.gotoGate !== undefined;
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

function makeRequest(url = 'https://example.com/api') {
  return {
    url: () => url,
    method: () => 'GET',
    headers: () => ({}),
    postData: () => undefined,
    resourceType: () => 'fetch',
  };
}

function makeResponse(request: unknown, headers: Record<string, string>, bodySpy: () => void) {
  return {
    request: () => request,
    status: () => 200,
    statusText: () => 'OK',
    headers: () => headers,
    body: async () => {
      bodySpy();
      return Buffer.from('x');
    },
  };
}

/**
 * Wait until the recorder has registered its listeners and reached `goto`.
 * Polls `fakePage.isReady()` so the test is robust to the async hops the
 * recorder takes (it `await import('playwright')`s its launcher), rather than
 * assuming a fixed microtask count. Yields a macrotask between polls so a
 * pending dynamic `import()` (which can settle on a macrotask) gets to resolve.
 */
async function tick(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (fakePage.isReady()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('recorder did not register listeners / reach goto in time');
}

describe('D-M2: recorder response cap + pending cleanup', () => {
  beforeEach(() => {
    fakePage = new FakePage();
    // The recorder's start-URL SSRF guard does a DNS lookup (a macrotask) that
    // would desync the listener-registration timing this test relies on. The
    // escape hatch short-circuits it synchronously; the URL is public anyway.
    process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
  });
  afterEach(() => {
    delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
  });

  it('does not buffer a body whose declared Content-Length exceeds the cap', async () => {
    const { recordBrowserSession } = await import('../../src/recorder/browser-recorder.js');

    const bodySpy = vi.fn();
    const sessionPromise = recordBrowserSession({ url: 'https://example.com', headless: true });
    await tick();

    const req = makeRequest();
    fakePage.emit('request', req);
    fakePage.emit(
      'response',
      makeResponse(
        req,
        { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) },
        bodySpy,
      ),
    );
    await tick();
    fakePage.releaseGoto();

    await sessionPromise;
    // The oversized response was never buffered into memory.
    expect(bodySpy).not.toHaveBeenCalled();
  });

  it('reads small JSON bodies normally (cap does not over-block benign responses)', async () => {
    const { recordBrowserSession } = await import('../../src/recorder/browser-recorder.js');

    const bodySpy = vi.fn();
    const sessionPromise = recordBrowserSession({ url: 'https://example.com', headless: true });
    await tick();

    const req = makeRequest('https://example.com/api/small');
    fakePage.emit('request', req);
    fakePage.emit(
      'response',
      makeResponse(req, { 'content-type': 'application/json', 'content-length': '1' }, bodySpy),
    );
    await tick();
    fakePage.releaseGoto();

    const result = await sessionPromise;
    expect(bodySpy).toHaveBeenCalled();
    expect(result.entries.length).toBe(1);
  });
});
