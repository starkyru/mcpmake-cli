import { describe, it, expect } from 'vitest';
import { renderSiteTemplate } from '../../src/emitter/site-template-loader.js';
import { scaffoldSiteProjectFiles } from '../../src/emitter/site-scaffolder.js';
import type { SiteProjectManifest } from '../../src/types/site.js';

const manifest: SiteProjectManifest = {
  serverName: 'example-site',
  serverVersion: '1.2.3',
  baseUrl: 'https://example.com',
  transport: 'http',
  siteDescriptor: {
    siteId: 'site_x',
    baseUrl: 'https://example.com',
    pages: [],
    analyzedAt: '2026-06-18T00:00:00.000Z',
    version: 1,
    crawlDepth: 2,
    metadata: {},
  },
  tools: [],
  envVars: [
    { name: 'BASE_URL', description: 'Target', required: true, example: 'https://example.com' },
  ],
  browserConfig: {
    headless: true,
    idleTimeoutMs: 300000,
    viewport: { width: 1280, height: 720 },
    maxSessions: 10,
  },
};

describe('generated site HTTP server — Origin check', () => {
  it('uses exact host comparison, not a substring match', () => {
    const out = renderSiteTemplate('server-main-http.ts', manifest);
    // The brittle substring check is gone…
    expect(out).not.toContain('origin.includes(allowedOrigin)');
    // …replaced by exact, case-insensitive host-to-host comparison.
    expect(out).toContain('originHost.toLowerCase() !== allowedHost.toLowerCase()');
    expect(out).toContain('new URL(originHeader).host');
  });
});

describe('generated handlers — selector string-literal injection is escaped', () => {
  it('escapes a single-quote-bearing selector so it cannot break out of the JS literal', () => {
    const malicious = "#x'];await page.evaluate(()=>1);//";
    const formTool = {
      name: 'evil',
      title: "it's a title",
      description: 'd',
      inputSchemaCode: '{ q: z.string() }',
      form: {
        fields: [{ name: 'q', fieldType: 'text', selector: { primary: malicious, fallbacks: [] } }],
      },
    };
    const out = renderSiteTemplate('tool-handler-form.ts', formTool);
    // The quote is escaped (\') so the literal stays intact…
    expect(out).toContain("'#x\\'];await page.evaluate(()=>1);//'");
    // …and the raw break-out sequence (quote immediately closing the literal) is absent.
    expect(out).not.toContain("['#x'];");
    // The freeform title is escaped too.
    expect(out).toContain("title: 'it\\'s a title'");
  });

  it('escapes a malicious link href in the action/navigation handler', () => {
    const linkTool = {
      name: 'go',
      title: 'Go',
      description: 'd',
      inputSchemaCode: '{}',
      link: { href: "https://x/'+process.exit(1)+'", isNavigation: true },
    };
    const out = renderSiteTemplate('tool-handler-action.ts', linkTool);
    expect(out).toContain("await page.goto('https://x/\\'+process.exit(1)+\\'',");
    expect(out).not.toContain("page.goto('https://x/'+process.exit(1)");
    // navigation-only tool must NOT import resolveSelector (unused-import smell)
    expect(out).toContain(
      "import { getOrCreateSession, takeScreenshot } from '../browser-manager.js';",
    );
    expect(out).not.toContain('resolveSelector');
  });
});

describe('generated site project — regeneration sidecar', () => {
  it('writes mcpmake.site.json with the regeneration metadata', () => {
    const units = scaffoldSiteProjectFiles(manifest);
    const sidecar = units.find((u) => u.filePath === 'mcpmake.site.json');
    expect(sidecar).toBeDefined();
    const meta = JSON.parse(sidecar!.content);
    expect(meta).toMatchObject({
      serverName: 'example-site',
      serverVersion: '1.2.3',
      transport: 'http',
      baseUrl: 'https://example.com',
    });
    expect(meta.browserConfig.maxSessions).toBe(10);
    expect(Array.isArray(meta.envVars)).toBe(true);
    // The bulky descriptor and tools are NOT duplicated into the sidecar.
    expect(meta.siteDescriptor).toBeUndefined();
    expect(meta.tools).toBeUndefined();
  });
});
