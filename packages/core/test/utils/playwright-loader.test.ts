import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * L-playwright: `playwright` is an OPTIONAL dependency. `loadChromium()` must:
 *  - return the playwright `chromium` value when the module resolves, and
 *  - reject with a clear, actionable error when the dynamic import fails
 *    (i.e. playwright was installed with `--omit=optional`), instead of letting
 *    a raw module-not-found error bubble out.
 *
 * We mock only the module boundary (`'playwright'`) — the unit under test
 * (`loadChromium`) is the real implementation. `vi.resetModules()` between cases
 * clears both the module registry and the loader's internal `cached`, so each
 * test re-imports a fresh loader bound to that case's mock.
 */

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('playwright');
});

describe('loadChromium', () => {
  it('returns the playwright chromium value when the module resolves', async () => {
    // Sentinel chromium: identity-comparable, so we prove the loader returns the
    // exact value exported by the (mocked) playwright module — not a copy.
    const sentinelChromium = { launch: () => Promise.resolve({}) };
    vi.doMock('playwright', () => ({ chromium: sentinelChromium }));

    const { loadChromium } = await import('../../src/utils/playwright-loader.js');
    const result = await loadChromium();

    expect(result).toBe(sentinelChromium);
  });

  it('caches the resolved value (loads playwright at most once)', async () => {
    const sentinelChromium = { launch: () => Promise.resolve({}) };
    vi.doMock('playwright', () => ({ chromium: sentinelChromium }));

    const { loadChromium } = await import('../../src/utils/playwright-loader.js');
    const first = await loadChromium();
    const second = await loadChromium();

    expect(first).toBe(sentinelChromium);
    expect(second).toBe(first);
  });

  it('rejects with an actionable error when the import fails (playwright not installed)', async () => {
    // Simulate `--omit=optional`: the dynamic import throws module-not-found.
    vi.doMock('playwright', () => {
      throw new Error("Cannot find module 'playwright'");
    });

    const { loadChromium } = await import('../../src/utils/playwright-loader.js');

    // The raw module-not-found message must NOT surface; the actionable one must.
    await expect(loadChromium()).rejects.toThrow(/require the optional "playwright" dependency/);
    await expect(loadChromium()).rejects.toThrow(/npx playwright install chromium/);
    // And it must not leak the underlying loader-internal failure verbatim.
    await expect(loadChromium()).rejects.not.toThrow(/Cannot find module/);
  });
});
