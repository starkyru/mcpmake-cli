import { defineCommand } from 'citty';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';
import type { ToolDefinition } from '@mcpmake/core';

export interface LintResult {
  level: 'error' | 'warn' | 'info';
  rule: string;
  tool: string;
  message: string;
}

const MCP_BUILT_INS = new Set([
  'ping',
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'logging/setLevel',
  'completion/complete',
  'sampling/createMessage',
  'roots/list',
]);

function lintTools(tools: ToolDefinition[]): LintResult[] {
  const results: LintResult[] = [];

  // duplicate-names: check for collisions
  const nameCount = new Map<string, number>();
  for (const tool of tools) {
    nameCount.set(tool.name, (nameCount.get(tool.name) ?? 0) + 1);
  }
  for (const [name, count] of nameCount) {
    if (count > 1) {
      results.push({
        level: 'error',
        rule: 'duplicate-names',
        tool: name,
        message: `Tool name "${name}" is used ${count} times — names must be unique`,
      });
    }
  }

  for (const tool of tools) {
    // tool-name-length
    if (tool.name.length > 128) {
      results.push({
        level: 'error',
        rule: 'tool-name-length',
        tool: tool.name,
        message: `Name is ${tool.name.length} chars — exceeds MCP spec limit of 128`,
      });
    } else if (tool.name.length > 60) {
      results.push({
        level: 'warn',
        rule: 'tool-name-length',
        tool: tool.name,
        message: `Name is ${tool.name.length} chars — exceeds Cursor limit of 60`,
      });
    }

    // description-quality
    if (!tool.description || tool.description.trim().length === 0) {
      results.push({
        level: 'warn',
        rule: 'description-quality',
        tool: tool.name,
        message: 'Description is empty — AI clients need good descriptions to pick the right tool',
      });
    } else if (tool.description.trim().length < 10) {
      results.push({
        level: 'warn',
        rule: 'description-quality',
        tool: tool.name,
        message: `Description is only ${tool.description.trim().length} chars — consider adding more detail`,
      });
    }

    // description-length
    if (tool.description && tool.description.length > 1024) {
      results.push({
        level: 'warn',
        rule: 'description-length',
        tool: tool.name,
        message: `Description is ${tool.description.length} chars — over 1024 wastes context window`,
      });
    }

    // parameter-count
    const paramCount =
      tool.pathParams.length +
      tool.queryParams.length +
      tool.headerParams.length +
      (tool.hasRequestBody ? 1 : 0);
    if (paramCount > 10) {
      results.push({
        level: 'warn',
        rule: 'parameter-count',
        tool: tool.name,
        message: `Has ${paramCount} parameters — more than 10 is complex for AI to fill correctly`,
      });
    }

    // missing-annotations
    if (!tool.annotations) {
      results.push({
        level: 'info',
        rule: 'missing-annotations',
        tool: tool.name,
        message: 'No readOnlyHint/destructiveHint annotations set — consider adding for safety',
      });
    }

    // reserved-names
    if (MCP_BUILT_INS.has(tool.name)) {
      results.push({
        level: 'error',
        rule: 'reserved-names',
        tool: tool.name,
        message: `"${tool.name}" conflicts with MCP built-in method name`,
      });
    }
  }

  return results;
}

export default defineCommand({
  meta: {
    name: 'lint',
    description: 'Lint an OpenAPI spec for MCP compatibility issues',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Path or URL to an OpenAPI spec',
      required: true,
    },
    format: {
      type: 'string',
      description: 'Output format: "text" (default) or "json"',
      default: 'text',
    },
    level: {
      type: 'string',
      description: 'Minimum level to show: "info", "warn", or "error"',
      default: 'info',
    },
  },
  async run({ args }) {
    logger.info(`Linting spec: ${args.spec}`);

    const { api } = await loadOpenApiSpec(args.spec);
    const { operations } = extractOperations(api as OpenAPIV3.Document);

    if (operations.length === 0) {
      await fail('No operations found in the spec.');
    }

    const tools = buildAllTools(operations);
    logger.info(`Analyzing ${tools.length} tools...\n`);

    const allResults = lintTools(tools);

    // Filter by level
    const levelOrder: Record<string, number> = { info: 0, warn: 1, error: 2 };
    const minLevel = levelOrder[args.level ?? 'info'] ?? 0;
    const results = allResults.filter((r) => levelOrder[r.level] >= minLevel);

    if (args.format === 'json') {
      console.log(JSON.stringify(results, null, 2));
    } else {
      const icons: Record<string, string> = { error: 'ERROR', warn: 'WARN ', info: 'INFO ' };

      for (const r of results) {
        const icon = icons[r.level];
        console.log(`  ${icon}  [${r.rule}] ${r.tool}: ${r.message}`);
      }

      // Summary
      const errors = allResults.filter((r) => r.level === 'error').length;
      const warns = allResults.filter((r) => r.level === 'warn').length;
      const infos = allResults.filter((r) => r.level === 'info').length;

      console.log('');
      console.log(
        `  ${tools.length} tools, ${allResults.length} issues: ${errors} errors, ${warns} warnings, ${infos} info`,
      );

      if (errors > 0) {
        console.log('');
      } else if (allResults.length === 0) {
        logger.success('No issues found');
      }
    }

    // Exit code 1 if any errors
    if (allResults.some((r) => r.level === 'error')) {
      await fail('Lint failed with errors');
    }
  },
});
