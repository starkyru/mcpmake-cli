/**
 * MCP Apps output (`mcp-ui`): generate a sandboxed-iframe HTML UI for a generated MCP
 * server, conformant to the MCP-UI standard (MCP-UI-Org/mcp-ui):
 *   • the server exposes a UIResource at `ui://<server>/tools`,
 *   • mimeType `text/html;profile=mcp-app`,
 *   • the HTML runs in the host's sandboxed iframe and asks the host to invoke a tool via
 *     `window.parent.postMessage({ type: 'tool', payload: { toolName, params } }, '*')`.
 *
 * The generated UI is a TOOL LAUNCHER: it lists every tool with a JSON-params box and an
 * Invoke button that posts the tool-call message. Everything is inline (no external assets)
 * so it works under a strict iframe sandbox. PURE: a deterministic function of the inputs,
 * with all interpolated values HTML/JS-escaped (tool descriptions come from the source API
 * and must never break out of the markup).
 */

/** MCP-UI standard MIME type for inline HTML app content. */
export const MCP_UI_MIME = 'text/html;profile=mcp-app';

export interface McpUiTool {
  name: string;
  description: string;
}

export interface McpUiResource {
  uri: string;
  mimeType: string;
  text: string;
}

/** Escape a string for use in HTML text / double-quoted attribute context. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Slugify a server name for the `ui://` host segment (kebab, alnum + dashes). */
function uiSlug(serverName: string): string {
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'server';
}

/** The `ui://` resource URI for a server's tool launcher. */
export function mcpUiUri(serverName: string): string {
  return `ui://${uiSlug(serverName)}/tools`;
}

/**
 * Build the tool-launcher HTML. Each tool gets a JSON-params textarea and an Invoke button
 * that posts the MCP-UI `tool` message to the host. Tool names are JSON-encoded into the
 * script (so a name can never break the string literal); descriptions are HTML-escaped.
 */
export function buildMcpUiHtml(serverName: string, tools: readonly McpUiTool[]): string {
  const title = escapeHtml(serverName);
  const items = tools
    .map((t) => {
      const name = escapeHtml(t.name);
      const desc = escapeHtml(t.description || '');
      // data-tool carries the raw (escaped) name; the click handler reads it back.
      return (
        `      <li class="tool">\n` +
        `        <div class="tool-head"><code>${name}</code>${desc ? ` — <span class="desc">${desc}</span>` : ''}</div>\n` +
        `        <details><summary>params (JSON)</summary><textarea data-params="${name}">{}</textarea></details>\n` +
        `        <button type="button" data-tool="${name}">Invoke</button>\n` +
        `      </li>`
      );
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — MCP tools</title>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; margin: 1rem; color: #111; }
    h1 { font-size: 1.2rem; }
    ul { list-style: none; padding: 0; }
    .tool { border: 1px solid #ddd; border-radius: 6px; padding: .6rem .8rem; margin: .5rem 0; }
    .desc { color: #555; }
    textarea { width: 100%; box-sizing: border-box; font: 12px monospace; min-height: 3rem; }
    button { margin-top: .4rem; cursor: pointer; }
    code { background: #f4f4f4; padding: 0 .25rem; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${tools.length} tool${tools.length === 1 ? '' : 's'}. Edit the JSON params and click Invoke — the host runs the tool.</p>
  <ul>
${items}
  </ul>
  <script>
    document.querySelectorAll('button[data-tool]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-tool');
        var ta = document.querySelector('textarea[data-params="' + name + '"]');
        var params = {};
        try {
          params = ta && ta.value.trim() ? JSON.parse(ta.value) : {};
        } catch (e) {
          alert('Invalid JSON params for ' + name);
          return;
        }
        // MCP-UI host interaction: ask the host to call the tool.
        window.parent.postMessage({ type: 'tool', payload: { toolName: name, params: params } }, '*');
      });
    });
  </script>
</body>
</html>
`;
}

/** Build the full MCP-UI resource (uri + mimeType + HTML) for a server's tools. */
export function mcpUiResource(serverName: string, tools: readonly McpUiTool[]): McpUiResource {
  return {
    uri: mcpUiUri(serverName),
    mimeType: MCP_UI_MIME,
    text: buildMcpUiHtml(serverName, tools),
  };
}

/**
 * Generate the `src/mcp-ui.ts` module the server ships when MCP Apps output is enabled.
 * It registers the `ui://` UIResource via the MCP SDK; the HTML is embedded as a JSON-encoded
 * string constant (so any character in it is inert in the generated source).
 */
export function buildMcpUiModule(serverName: string, tools: readonly McpUiTool[]): string {
  const res = mcpUiResource(serverName, tools);
  // Mirrors the generated resources.ts registration pattern (McpServer + ResourceTemplate)
  // so it compiles against the same MCP SDK the rest of the server uses.
  return `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

const MCP_UI_URI = ${JSON.stringify(res.uri)};
const MCP_UI_MIME = ${JSON.stringify(res.mimeType)};
const MCP_UI_HTML = ${JSON.stringify(res.text)};

/**
 * Register the MCP Apps (mcp-ui) tool-launcher UI as a ui:// resource. Hosts that support
 * MCP Apps render MCP_UI_HTML in a sandboxed iframe; its Invoke buttons post a
 * { type: 'tool', payload: { toolName, params } } message to the host to call a tool.
 */
export function registerMcpUi(server: McpServer): void {
  server.registerResource(
    'mcp-ui',
    new ResourceTemplate(MCP_UI_URI, { list: undefined }),
    {
      title: ${JSON.stringify(`${serverName} UI`)},
      description: 'Interactive tool launcher (MCP Apps / mcp-ui)',
      mimeType: MCP_UI_MIME,
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_UI_MIME, text: MCP_UI_HTML }],
    }),
  );
}
`;
}
