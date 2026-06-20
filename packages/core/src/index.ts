/**
 * @mcpmake/core — the shared MCP-server generation library.
 *
 * Public API consumed by the `mcpmake` CLI (and the managed cloud). Everything
 * exported here is supported surface; deep imports into `@mcpmake/core/dist/...`
 * are not.
 */

// ---------------------------------------------------------------------------
// Emitter (code generation)
// ---------------------------------------------------------------------------
export {
  emitProject,
  emitPythonProject,
  emitWorkerProject,
  emitSiteProject,
} from './emitter/index.js';
export type { EmitOptions } from './emitter/index.js';
export { generateMcpb } from './emitter/mcpb-bundler.js';
export { renderTemplate } from './emitter/template-loader.js';
export { scaffoldSharedModules } from './emitter/project-scaffolder.js';

// ---------------------------------------------------------------------------
// Parser (OpenAPI / HAR / Postman ingestion)
// ---------------------------------------------------------------------------
export { loadOpenApiSpec } from './parser/openapi-loader.js';
export type { LoadResult } from './parser/openapi-loader.js';
export { applyOverlay } from './parser/overlay-loader.js';
export { extractOperations } from './parser/operation-extractor.js';
export type { ExtractionResult } from './parser/operation-extractor.js';
export { jsonSchemaToZodCode, buildOperationInputSchema } from './parser/schema-converter.js';
export { loadHarFile } from './parser/har-loader.js';
export { filterHarEntries } from './parser/har-filter.js';
export type { FilterOptions } from './parser/har-filter.js';
export { normalizeEntry } from './parser/har-normalizer.js';
export type { NormalizedEntry, PathParam, QueryParam } from './parser/har-normalizer.js';
export { loadPostmanCollection } from './parser/postman-loader.js';

// ---------------------------------------------------------------------------
// Transformer (operations -> tools/resources/prompts)
// ---------------------------------------------------------------------------
export {
  toToolName,
  toToolTitle,
  toFileName,
  toFunctionName,
  deriveResourceName,
} from './transformer/naming.js';
export { resourceTreeNames } from './transformer/resource-namer.js';
export { detectAuthSchemes } from './transformer/auth-detector.js';
export { buildToolDefinition, buildAllTools } from './transformer/tool-builder.js';
export { filterOperations } from './transformer/operation-filter.js';
export { buildResources, buildPrompts } from './transformer/resource-builder.js';
export { applyClientCompat } from './transformer/client-compat.js';
export type { ClientMode } from './transformer/client-compat.js';
export { improveToolNames } from './transformer/llm-namer.js';
export { resolveModel } from './utils/model-resolver.js';
export type { ModelTier } from './utils/model-resolver.js';
export { clusterEntries } from './transformer/har-clusterer.js';
export type { EntryCluster } from './transformer/har-clusterer.js';
export { clustersToOperations } from './transformer/har-to-operations.js';
export type { HarConversionResult, DetectedAuth } from './transformer/har-to-operations.js';
export { deduplicateEntries } from './transformer/har-dedup.js';
export {
  inferJsonSchema,
  inferResponseSchema,
  inferRequestBodySchema,
} from './transformer/har-schema-inferrer.js';
export { parseStainlessConfig, resolveSpecPath } from './transformer/stainless-config.js';
export { translateStainless } from './transformer/stainless-translator.js';

// ---------------------------------------------------------------------------
// Analyzer (website crawling / form detection)
// ---------------------------------------------------------------------------
export { crawlSite } from './analyzer/site-crawler.js';
export type { CrawlOptions, CrawlResult } from './analyzer/site-crawler.js';
export { parsePage } from './analyzer/dom-parser.js';
export { buildSelectorSet, validateSelector } from './analyzer/selector-builder.js';
export { analyzeSemantics } from './analyzer/semantic-analyzer.js';
export { detectAuthFlow } from './analyzer/auth-detector.js';
export { classifyForms } from './analyzer/hybrid-detector.js';
export type { HybridClassification } from './analyzer/hybrid-detector.js';
export { goalDirectedCrawl } from './analyzer/goal-crawler.js';
export type { GoalCrawlOptions } from './analyzer/goal-crawler.js';

// ---------------------------------------------------------------------------
// Site transformer (browser tools / selector healing)
// ---------------------------------------------------------------------------
export { generateSiteTools } from './site-transformer/tool-generator.js';
export { buildBrowserLifecycleTools } from './site-transformer/browser-tools.js';
export { healBrokenSelector } from './site-transformer/selector-healer.js';

// ---------------------------------------------------------------------------
// Generator (LLM spec synthesis)
// ---------------------------------------------------------------------------
export { generateSpecFromDescription } from './generator/spec-generator.js';

// ---------------------------------------------------------------------------
// Providers (known-API presets)
// ---------------------------------------------------------------------------
export { getProvider, listProviders, getProviderNames } from './providers/index.js';
export type { ProviderConfig } from './providers/index.js';

// ---------------------------------------------------------------------------
// Recorder (browser session capture)
// ---------------------------------------------------------------------------
export { recordBrowserSession } from './recorder/browser-recorder.js';

// ---------------------------------------------------------------------------
// Rescan (scheduled re-generation)
// ---------------------------------------------------------------------------
export { diffSiteDescriptors } from './rescan/diff-engine.js';
export { RescanScheduler, computeNextRun } from './rescan/rescan-scheduler.js';
export type { ScheduleEntry, RescanCallback } from './rescan/rescan-scheduler.js';
export { collectLowConfidenceSelectors, summarizeRescan } from './rescan/rescan-runner.js';
export type { LowConfidenceSelector, RescanSummary, ChangeCounts } from './rescan/rescan-runner.js';

// ---------------------------------------------------------------------------
// Config (shared command/config plumbing)
// ---------------------------------------------------------------------------
export { defineConfigurableCommand } from './config/configurable-command.js';

// ---------------------------------------------------------------------------
// Plugins (adapter registry)
// ---------------------------------------------------------------------------
export { registerAdapter, getAdapter, listAdapters } from './plugins/loader.js';
export type { McpmakeAdapter } from './plugins/adapter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export * from './types/index.js';
export * from './types/site.js';

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
export { logger } from './utils/logger.js';
export { fail } from './utils/fail.js';
export { pathExists } from './utils/fs.js';
export { confirmOperations } from './utils/interactive.js';
export { watchFile } from './utils/watcher.js';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
export { FAMILY_A_PRICING, DEFAULT_PRICING_SERVER, fetchPricing, formatPrice } from './pricing.js';
export type { BillingPeriod, PricePoint } from './pricing.js';
