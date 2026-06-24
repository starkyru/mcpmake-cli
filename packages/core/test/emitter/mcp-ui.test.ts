import { describe, it, expect } from 'vitest';
import {
  buildMcpUiHtml,
  buildMcpUiModule,
  mcpUiResource,
  mcpUiUri,
  MCP_UI_MIME,
} from '../../src/emitter/mcp-ui.js';

describe('mcp-ui generator', () => {
  const tools = [
    { name: 'list_pets', description: 'List the pets' },
    { name: 'create_pet', description: 'Create a pet' },
  ];

  it('builds a UIResource conformant to the MCP-UI standard (uri + mime)', () => {
    const r = mcpUiResource('Petstore', tools);
    expect(r.uri).toBe('ui://petstore/tools');
    expect(r.mimeType).toBe('text/html;profile=mcp-app');
    expect(r.mimeType).toBe(MCP_UI_MIME);
    expect(r.text).toContain('<!doctype html>');
  });

  it('lists every tool with an Invoke button + a params box', () => {
    const html = buildMcpUiHtml('Petstore', tools);
    expect(html).toContain('list_pets');
    expect(html).toContain('create_pet');
    expect(html).toContain('List the pets');
    expect((html.match(/data-tool=/g) ?? []).length).toBe(2); // one button per tool
    expect((html.match(/textarea data-params=/g) ?? []).length).toBe(2);
  });

  it('uses the MCP-UI postMessage tool-call protocol', () => {
    const html = buildMcpUiHtml('Petstore', tools);
    // The exact host-interaction message the spec defines.
    expect(html).toContain('window.parent.postMessage');
    expect(html).toContain("{ type: 'tool', payload: { toolName: name, params: params } }");
  });

  it('HTML-escapes tool descriptions so source text cannot break out of the markup', () => {
    const html = buildMcpUiHtml('x', [
      { name: 'evil', description: '</textarea><script>alert(1)</script>' },
    ]);
    // The raw description must NOT appear; its escaped form must.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is deterministic (same inputs → byte-identical HTML)', () => {
    expect(buildMcpUiHtml('Petstore', tools)).toBe(buildMcpUiHtml('Petstore', tools));
  });

  it('slugifies the server name for the ui:// host', () => {
    expect(mcpUiUri('My Cool API!')).toBe('ui://my-cool-api/tools');
    expect(mcpUiUri('')).toBe('ui://server/tools');
  });

  it('buildMcpUiModule emits a registerMcpUi module wiring the ui:// resource to the SDK', () => {
    const mod = buildMcpUiModule('petstore', tools);
    // Same SDK registration pattern as the generated resources module (so it compiles).
    expect(mod).toContain("from '@modelcontextprotocol/sdk/server/mcp.js'");
    expect(mod).toContain('export function registerMcpUi(server: McpServer): void');
    expect(mod).toContain('server.registerResource');
    expect(mod).toContain('new ResourceTemplate(MCP_UI_URI');
    expect(mod).toContain('ui://petstore/tools');
    expect(mod).toContain('text/html;profile=mcp-app');
    // The HTML is embedded as a JSON-encoded string constant (inert in source).
    expect(mod).toContain('const MCP_UI_HTML = "');
  });
});
