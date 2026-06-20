import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseIntFlag } from '../../../src/commands/from/website.js';

// Capture the manifest handed to emitSiteProject so we can assert how CLI flags
// thread into the emitted BrowserConfig, without running a real crawl.
const emitCalls: { manifest: unknown }[] = [];

vi.mock('@mcpmake/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcpmake/core')>();
  const siteDescriptor = {
    siteId: 'site_test',
    baseUrl: 'https://example.com',
    analyzedAt: '2026-06-18T00:00:00.000Z',
    version: 1,
    crawlDepth: 2,
    metadata: {},
    pages: [
      {
        pageId: 'page_1',
        url: 'https://example.com/',
        analyzedAt: '2026-06-18T00:00:00.000Z',
        forms: [],
        buttons: [
          {
            buttonId: 'btn_1',
            type: 'button',
            text: 'Go',
            selector: { primary: '#go', fallbacks: [], strategy: 'css-path', confidence: 0.9 },
          },
        ],
        links: [],
      },
    ],
  };
  return {
    ...actual,
    crawlSite: vi.fn(async () => ({ siteDescriptor, screenshots: new Map(), harEntries: [] })),
    generateSiteTools: vi.fn(() => [
      {
        name: 'click_go',
        title: 'Click Go',
        description: 'Click the Go button',
        inputSchemaCode: 'z.object({})',
        fileName: 'click-go',
        functionName: 'clickGo',
        toolType: 'page-action' as const,
        selectors: [],
        returnsScreenshot: false,
      },
    ]),
    emitSiteProject: vi.fn(async (manifest: unknown) => {
      emitCalls.push({ manifest });
    }),
  };
});

describe('parseIntFlag', () => {
  it('returns the fallback when the flag is unset or empty', () => {
    expect(parseIntFlag(undefined, 'depth', 2)).toBe(2);
    expect(parseIntFlag('', 'depth', 2)).toBe(2);
  });

  it('parses a valid non-negative integer', () => {
    expect(parseIntFlag('5', 'max-pages', 20)).toBe(5);
    expect(parseIntFlag('0', 'static-tools', 7)).toBe(0);
  });

  it('throws on non-numeric input instead of silently coercing to 0', () => {
    expect(() => parseIntFlag('abc', 'static-tools', 0)).toThrow(/Invalid --static-tools/);
  });

  it('throws on negative and non-integer input', () => {
    expect(() => parseIntFlag('-3', 'max-pages', 20)).toThrow(/Invalid --max-pages/);
    expect(() => parseIntFlag('2.5', 'depth', 2)).toThrow(/Invalid --depth/);
  });
});

describe('website command BrowserConfig threading', () => {
  let websiteCommand: { run?: (ctx: { args: Record<string, unknown> }) => Promise<unknown> };

  beforeEach(async () => {
    emitCalls.length = 0;
    websiteCommand = (await import('../../../src/commands/from/website.js'))
      .default as typeof websiteCommand;
  });

  it('threads --timeout and --headless into the emitted BrowserConfig', async () => {
    await websiteCommand.run!({
      args: {
        url: 'https://example.com',
        output: '/tmp/does-not-matter',
        timeout: '120',
        headless: true,
        'dry-run': true,
        force: false,
      },
    });

    expect(emitCalls).toHaveLength(1);
    const manifest = emitCalls[0].manifest as {
      browserConfig: { headless: boolean; idleTimeoutMs: number };
    };
    expect(manifest.browserConfig.headless).toBe(true);
    expect(manifest.browserConfig.idleTimeoutMs).toBe(120 * 1000);
  });

  it('falls back to defaults (headless true, 300s) when flags are unset', async () => {
    await websiteCommand.run!({
      args: {
        url: 'https://example.com',
        output: '/tmp/does-not-matter',
        'dry-run': true,
        force: false,
      },
    });

    expect(emitCalls).toHaveLength(1);
    const manifest = emitCalls[0].manifest as {
      browserConfig: { headless: boolean; idleTimeoutMs: number };
    };
    expect(manifest.browserConfig.headless).toBe(true);
    expect(manifest.browserConfig.idleTimeoutMs).toBe(300 * 1000);
  });
});
