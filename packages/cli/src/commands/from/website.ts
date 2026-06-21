import { defineConfigurableCommand } from '@mcpmake/core';
import { crawlSite } from '@mcpmake/core';
import { goalDirectedCrawl } from '@mcpmake/core';
import { classifyForms } from '@mcpmake/core';
import type { HybridClassification } from '@mcpmake/core';
import { analyzeSemantics } from '@mcpmake/core';
import { detectAuthFlow } from '@mcpmake/core';
import { generateSiteTools } from '@mcpmake/core';
import { filterHarEntries } from '@mcpmake/core';
import { normalizeEntry } from '@mcpmake/core';
import { clusterEntries } from '@mcpmake/core';
import { clustersToOperations } from '@mcpmake/core';
import { deduplicateEntries } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { emitSiteProject } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { apiKeyArg, applyApiKey, modelArg, providerArg } from '../api-key.js';
import type { SiteProjectManifest, BrowserConfig, SiteToolDefinition } from '@mcpmake/core';

function toPackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse a numeric CLI flag as a non-negative integer. Unlike a bare
 * `parseInt`, this rejects non-numeric / negative input with a clear error
 * instead of silently coercing it to NaN→0 (which would zero out scope, e.g.
 * `--max-pages abc` crawling nothing). An unset flag falls back to `fallback`.
 */
export function parseIntFlag(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid --${flag}: "${value}" (expected a non-negative integer)`);
  }
  return n;
}

export default defineConfigurableCommand('website', {
  meta: {
    name: 'website',
    description: "Generate a Playwright-based MCP server by analyzing a website's DOM",
  },
  args: {
    url: {
      type: 'positional',
      description: 'URL of the website to analyze',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output directory for generated project',
      required: true,
    },
    name: {
      type: 'string',
      alias: 'n',
      description: 'Server name (defaults to hostname)',
    },
    depth: {
      type: 'string',
      description: 'Crawl depth (default: 2)',
      default: '2',
    },
    'max-pages': {
      type: 'string',
      description: 'Maximum pages to crawl (default: 20)',
      default: '20',
    },
    timeout: {
      type: 'string',
      description: 'Idle timeout in seconds (default: 300)',
      default: '300',
    },
    transport: {
      type: 'string',
      alias: 't',
      description: 'Transport mode: "stdio" (default) or "http"',
      default: 'stdio',
    },
    headless: {
      type: 'boolean',
      description: 'Run browser in headless mode during analysis',
      default: false,
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Overwrite existing output directory',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview generated files without writing',
      default: false,
    },
    'improve-names': {
      type: 'boolean',
      description: 'Use LLM to infer semantic names for forms, buttons, and links',
      default: false,
    },
    'max-sessions': {
      type: 'string',
      description: 'Maximum concurrent browser sessions for the generated server (default: 10)',
      default: '10',
    },
    hybrid: {
      type: 'boolean',
      description:
        'Hybrid mode: use HTTP fetch for API-backed forms and Playwright for browser-only forms',
      default: false,
    },
    goal: {
      type: 'string',
      description:
        'Goal-directed crawl: use an LLM to navigate toward a goal instead of BFS crawling (requires an LLM API key: ANTHROPIC_API_KEY, or OPENAI_API_KEY with --provider openai)',
    },
    'api-key': apiKeyArg,
    provider: providerArg,
    model: modelArg,
  },
  async run({ args }) {
    applyApiKey(args);

    const url = args.url;
    const depth = parseIntFlag(args.depth, 'depth', 2);
    const maxPages = parseIntFlag(args['max-pages'], 'max-pages', 20);
    const timeoutSec = parseIntFlag(args.timeout, 'timeout', 300);
    const timeoutMs = timeoutSec * 1000;
    const maxSessions = parseIntFlag(args['max-sessions'], 'max-sessions', 10);
    const hybridMode = args.hybrid ?? false;
    const goal = args.goal as string | undefined;

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      return await fail(`Invalid URL: ${url}`, err);
    }

    logger.info(`Analyzing website: ${url}`);

    let siteDescriptor;
    let screenshots: Map<string, Buffer>;
    let harEntries: import('har-format').Entry[] | undefined;

    if (goal) {
      // Goal-directed crawl: use LLM to navigate toward the goal
      logger.info(`Goal-directed crawl: "${goal}"`);
      const result = await goalDirectedCrawl({
        url,
        goal,
        maxSteps: maxPages,
        headless: args.headless ?? false,
        model: args.model,
      });
      siteDescriptor = result.siteDescriptor;
      screenshots = result.screenshots;
    } else {
      // Standard BFS crawl (with optional HAR capture for hybrid mode)
      logger.info(`Crawl depth: ${depth}, Max pages: ${maxPages}`);
      const result = await crawlSite({
        url,
        depth,
        maxPages,
        timeout: timeoutMs,
        headless: args.headless ?? false,
        captureHar: hybridMode,
      });
      siteDescriptor = result.siteDescriptor;
      screenshots = result.screenshots;
      harEntries = result.harEntries;
    }

    const totalForms = siteDescriptor.pages.reduce((n, p) => n + p.forms.length, 0);
    const totalButtons = siteDescriptor.pages.reduce((n, p) => n + p.buttons.length, 0);
    const totalLinks = siteDescriptor.pages.reduce((n, p) => n + p.links.length, 0);

    logger.info(
      `Discovered: ${siteDescriptor.pages.length} pages, ${totalForms} forms, ${totalButtons} buttons, ${totalLinks} links`,
    );
    logger.info(`Screenshots captured: ${screenshots.size}`);

    if (siteDescriptor.pages.length === 0) {
      await fail('No pages could be analyzed. Check the URL and try again.');
    }

    // Semantic analysis (optional, requires an LLM API key)
    if (args['improve-names']) {
      siteDescriptor.pages = await analyzeSemantics(siteDescriptor.pages, args.model);
    }

    // Auth flow detection
    const authFlow = detectAuthFlow(siteDescriptor.pages);
    if (authFlow) {
      siteDescriptor.authFlow = authFlow;
    }

    // Generate browser-based tools from site descriptor
    const siteTools = generateSiteTools(siteDescriptor);

    // Hybrid mode: classify forms and merge API tools with browser tools
    let tools: SiteToolDefinition[];
    let hybridClassifications: HybridClassification[] | undefined;

    if (hybridMode && harEntries && harEntries.length > 0) {
      logger.info(`Hybrid mode: analyzing ${harEntries.length} captured network requests`);

      // Classify all forms
      const allForms = siteDescriptor.pages.flatMap((p) => p.forms);
      hybridClassifications = classifyForms(allForms, harEntries);

      const apiFormIds = new Set(
        hybridClassifications.filter((c) => c.strategy === 'api').map((c) => c.formId),
      );

      const apiCount = apiFormIds.size;
      const browserCount = hybridClassifications.length - apiCount;
      logger.info(
        `Hybrid classification: ${apiCount} API-backed forms, ${browserCount} browser-only forms`,
      );

      // Build API tools from HAR entries
      const targetHost = new URL(url).hostname;
      const filteredHar = filterHarEntries(harEntries, {
        allowedDomains: [targetHost],
        includeErrors: false,
      });

      if (filteredHar.length > 0) {
        const normalized = filteredHar.map(normalizeEntry);
        const deduped = deduplicateEntries(normalized);
        const clusters = clusterEntries(deduped);
        const { operations } = clustersToOperations(clusters);
        const apiTools = buildAllTools(operations);

        // Remove browser-based form tools that have API equivalents
        const browserTools = siteTools.filter((tool) => {
          if (tool.form && apiFormIds.has(tool.form.formId)) {
            return false; // Prefer the API tool
          }
          return true;
        });

        // Convert API ToolDefinitions to SiteToolDefinitions for uniform output
        const apiSiteTools: SiteToolDefinition[] = apiTools.map((apiTool) => ({
          name: apiTool.name,
          title: apiTool.title,
          description: `[API] ${apiTool.description}`,
          inputSchemaCode: apiTool.inputSchemaCode,
          fileName: apiTool.fileName,
          functionName: apiTool.functionName,
          toolType: 'page-action' as const,
          selectors: [],
          returnsScreenshot: false,
          annotations: apiTool.annotations,
        }));

        tools = [...browserTools, ...apiSiteTools];

        // Deduplicate by name
        const seenNames = new Set<string>();
        tools = tools.filter((tool) => {
          if (seenNames.has(tool.name)) return false;
          seenNames.add(tool.name);
          return true;
        });
      } else {
        tools = siteTools;
      }
    } else {
      tools = siteTools;
    }

    logger.info(`Generated ${tools.length} MCP tools`);

    if (tools.length === 0) {
      await fail('No interactive elements found on the site.');
    }

    // Build manifest
    const serverName = args.name ?? toPackageName(parsedUrl.hostname);
    const transport = args.transport === 'http' ? 'http' : 'stdio';

    const browserConfig: BrowserConfig = {
      // Informational: the generated server resolves its own runtime default via
      // `HEADLESS !== 'false'` (config.ts.hbs), so this field is not emitted as the
      // server default. Mirror the `--headless` flag (citty default false), matching
      // the crawl-time usages above, instead of a dead `?? true` fallback.
      headless: args.headless ?? false,
      idleTimeoutMs: timeoutMs,
      viewport: { width: 1280, height: 720 },
      maxSessions,
    };

    const manifest: SiteProjectManifest = {
      serverName,
      serverVersion: '1.0.0',
      baseUrl: siteDescriptor.baseUrl,
      transport: transport as 'stdio' | 'http',
      siteDescriptor,
      tools,
      envVars: [
        {
          name: 'BASE_URL',
          description: 'Target website URL',
          required: true,
          example: siteDescriptor.baseUrl,
        },
      ],
      browserConfig,
    };

    // Emit the project
    logger.info(`Generating Playwright MCP server: ${serverName}`);
    await emitSiteProject(manifest, {
      outputDir: args.output,
      force: args.force ?? false,
      dryRun: args['dry-run'] ?? false,
    });

    logger.success(`Site MCP server generated at: ${args.output}`);
    logger.info('');
    logger.info(`Pages analyzed: ${siteDescriptor.pages.length}`);
    logger.info(`Tools generated: ${tools.length}`);
    logger.info('');
    logger.info('Tools:');
    for (const tool of tools) {
      const typeTag = `[${tool.toolType}]`;
      logger.info(`  ${tool.name} ${typeTag} — ${tool.description.slice(0, 60)}`);
    }
    logger.info('');
    logger.info('Next steps:');
    logger.info(`  cd ${args.output}`);
    logger.info('  npm install');
    logger.info('  npx playwright install chromium');
    logger.info('  npm run build');
    logger.info('  npm start');
  },
});
