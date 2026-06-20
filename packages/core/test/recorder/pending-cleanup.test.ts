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

async function tick(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
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

  it("registers 'requestfailed'/'requestfinished' handlers and produces no entry for a request that never gets a response", async () => {
    const { recordBrowserSession } = await import('../../src/recorder/browser-recorder.js');

    const sessionPromise = recordBrowserSession({ url: 'https://example.com', headless: true });
    await tick();

    // Terminal handlers must be wired so failed/finished requests are freed.
    expect(fakePage.listenerCount('requestfailed')).toBe(1);
    expect(fakePage.listenerCount('requestfinished')).toBe(1);

    const failing = makeRequest('https://example.com/aborted');
    fakePage.emit('request', failing);
    // No 'response' ever fires for this request — it just fails.
    fakePage.emit('requestfailed', failing);

    const finishing = makeRequest('https://example.com/redirect');
    fakePage.emit('request', finishing);
    fakePage.emit('requestfinished', finishing);

    await tick();
    fakePage.releaseGoto();

    const result = await sessionPromise;
    // Neither request produced a captured entry (no readable response).
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
