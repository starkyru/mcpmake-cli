import { describe, it, expect } from 'vitest';
import { createChangeHandler } from '../../src/utils/watcher.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createChangeHandler — coalescing (L-watcher)', () => {
  it('debounces a rapid burst into a single run', async () => {
    let runs = 0;
    const h = createChangeHandler(async () => {
      runs++;
    }, 10);

    h.notify();
    h.notify();
    h.notify();
    await sleep(40);

    expect(runs).toBe(1);
  });

  it('coalesces many mid-run changes into exactly one trailing run', async () => {
    let runs = 0;
    let releaseFirst: (() => void) | undefined;
    const firstHold = new Promise<void>((res) => (releaseFirst = res));
    let firstStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((res) => (firstStarted = res));

    const h = createChangeHandler(async () => {
      runs++;
      if (runs === 1) {
        firstStarted!();
        await firstHold; // hold the first run open so changes land mid-run
      }
    }, 10);

    h.notify();
    await firstGate; // first run is now in flight and blocked

    // Many changes during the active run must collapse to one trailing run.
    h.notify();
    h.notify();
    h.notify();
    h.notify();

    releaseFirst!();
    await sleep(40);

    expect(runs).toBe(2);
  });

  it('does not drop a single change that arrives mid-run', async () => {
    let runs = 0;
    let releaseFirst: (() => void) | undefined;
    const firstHold = new Promise<void>((res) => (releaseFirst = res));
    let firstStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((res) => (firstStarted = res));

    const h = createChangeHandler(async () => {
      runs++;
      if (runs === 1) {
        firstStarted!();
        await firstHold;
      }
    }, 10);

    h.notify();
    await firstGate;
    h.notify(); // one change while running → must produce a trailing run
    releaseFirst!();
    await sleep(40);

    expect(runs).toBe(2);
  });

  it('does not fire a trailing run when no change arrives mid-run', async () => {
    let runs = 0;
    const h = createChangeHandler(async () => {
      runs++;
      await sleep(15);
    }, 10);

    h.notify();
    await sleep(60); // run completes; no mid-run notify → no trailing run

    expect(runs).toBe(1);
  });
});
