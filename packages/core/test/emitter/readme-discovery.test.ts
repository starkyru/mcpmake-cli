import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../src/emitter/template-loader.js';

function renderReadme(data: Record<string, unknown>): string {
  return renderTemplate('readme.md', {
    serverName: 'demo',
    serverVersion: '1.0.0',
    transport: 'stdio',
    authEnvVars: [],
    tools: [],
    ...data,
  });
}

const manyTools = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: 'desc' }));

describe('generated README: --dynamic-discovery surfacing', () => {
  it('recommends --dynamic-discovery for a large API not using it', () => {
    const md = renderReadme({
      tools: manyTools(50),
      dynamicDiscovery: false,
      recommendDiscovery: true,
    });
    expect(md).toContain('--dynamic-discovery');
    expect(md).toContain('large API (50 tools)');
    expect(md).not.toContain('Dynamic discovery is enabled');
  });

  it('documents discovery when it is enabled', () => {
    const md = renderReadme({
      tools: manyTools(60),
      dynamicDiscovery: true,
      recommendDiscovery: false,
    });
    expect(md).toContain('Dynamic discovery is enabled');
    expect(md).not.toContain('Tip — large API');
  });

  it('stays quiet for a small API', () => {
    const md = renderReadme({
      tools: manyTools(3),
      dynamicDiscovery: false,
      recommendDiscovery: false,
    });
    expect(md).not.toContain('--dynamic-discovery');
    expect(md).not.toContain('Dynamic discovery is enabled');
  });
});
