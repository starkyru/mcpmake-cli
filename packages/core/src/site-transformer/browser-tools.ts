/**
 * Built-in browser lifecycle tools that every generated site MCP server includes.
 * These are not derived from site analysis — they manage the Playwright browser.
 */

import type { SiteToolDefinition } from '../types/site.js';

/**
 * Returns the three built-in browser lifecycle tools:
 * start_browser, stop_browser, take_screenshot
 */
export function buildBrowserLifecycleTools(): SiteToolDefinition[] {
  return [
    {
      name: 'start_browser',
      title: 'Start Browser',
      description:
        'Launch a browser session. Returns a sessionId for subsequent tool calls. ' +
        'If a sessionId is provided, reuses that existing session.',
      inputSchemaCode: `z.object({
  sessionId: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Reuse an existing session instead of starting a new one'),
  headless: z.boolean().optional().describe('Run in headless mode (default: from server config)'),
})`,
      fileName: 'start-browser',
      functionName: 'startBrowser',
      toolType: 'browser-lifecycle',
      selectors: [],
      returnsScreenshot: false,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    {
      name: 'stop_browser',
      title: 'Stop Browser',
      description:
        'Close a browser session and free resources. ' +
        'If no sessionId is given, closes the default session.',
      inputSchemaCode: `z.object({
  sessionId: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Session to close. If omitted, closes default session'),
})`,
      fileName: 'stop-browser',
      functionName: 'stopBrowser',
      toolType: 'browser-lifecycle',
      selectors: [],
      returnsScreenshot: false,
      annotations: { destructiveHint: true },
    },
    {
      name: 'take_screenshot',
      title: 'Take Screenshot',
      description:
        'Capture a screenshot of the current page. ' +
        'Returns the screenshot as a base64-encoded PNG image.',
      inputSchemaCode: `z.object({
  sessionId: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Session to screenshot. If omitted, uses default session'),
  fullPage: z.boolean().optional().describe('Capture the full scrollable page (default: false)'),
})`,
      fileName: 'take-screenshot',
      functionName: 'takeScreenshot',
      toolType: 'browser-lifecycle',
      selectors: [],
      returnsScreenshot: true,
      annotations: { readOnlyHint: true },
    },
  ];
}
