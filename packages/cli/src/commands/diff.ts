import { defineCommand } from 'citty';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { buildAllTools } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';
import type { ToolDefinition } from '@mcpmake/core';

interface ToolChange {
  field: string;
  old: string;
  new: string;
}

interface DiffResult {
  added: ToolDefinition[];
  removed: ToolDefinition[];
  changed: Array<{ tool: ToolDefinition; changes: ToolChange[] }>;
  unchanged: number;
}

function diffTools(oldTools: ToolDefinition[], newTools: ToolDefinition[]): DiffResult {
  const oldByName = new Map(oldTools.map((t) => [t.name, t]));
  const newByName = new Map(newTools.map((t) => [t.name, t]));

  const added: ToolDefinition[] = [];
  const removed: ToolDefinition[] = [];
  const changed: Array<{ tool: ToolDefinition; changes: ToolChange[] }> = [];
  let unchanged = 0;

  // Find removed and changed
  for (const [name, oldTool] of oldByName) {
    const newTool = newByName.get(name);
    if (!newTool) {
      removed.push(oldTool);
      continue;
    }

    const changes: ToolChange[] = [];

    if (oldTool.method !== newTool.method) {
      changes.push({
        field: 'method',
        old: oldTool.method.toUpperCase(),
        new: newTool.method.toUpperCase(),
      });
    }

    if (oldTool.pathTemplate !== newTool.pathTemplate) {
      changes.push({
        field: 'path',
        old: oldTool.pathTemplate,
        new: newTool.pathTemplate,
      });
    }

    if (oldTool.description !== newTool.description) {
      changes.push({
        field: 'description',
        old: oldTool.description.slice(0, 80) + (oldTool.description.length > 80 ? '...' : ''),
        new: newTool.description.slice(0, 80) + (newTool.description.length > 80 ? '...' : ''),
      });
    }

    // Compare parameters
    const oldParams = new Set([
      ...oldTool.pathParams,
      ...oldTool.queryParams,
      ...oldTool.headerParams,
    ]);
    const newParams = new Set([
      ...newTool.pathParams,
      ...newTool.queryParams,
      ...newTool.headerParams,
    ]);

    const addedParams = [...newParams].filter((p) => !oldParams.has(p));
    const removedParams = [...oldParams].filter((p) => !newParams.has(p));

    if (addedParams.length > 0) {
      changes.push({
        field: 'parameters (added)',
        old: '',
        new: addedParams.join(', '),
      });
    }
    if (removedParams.length > 0) {
      changes.push({
        field: 'parameters (removed)',
        old: removedParams.join(', '),
        new: '',
      });
    }

    if (oldTool.hasRequestBody !== newTool.hasRequestBody) {
      changes.push({
        field: 'request body',
        old: oldTool.hasRequestBody ? 'present' : 'absent',
        new: newTool.hasRequestBody ? 'present' : 'absent',
      });
    }

    if (changes.length > 0) {
      changed.push({ tool: newTool, changes });
    } else {
      unchanged++;
    }
  }

  // Find added
  for (const [name, newTool] of newByName) {
    if (!oldByName.has(name)) {
      added.push(newTool);
    }
  }

  return { added, removed, changed, unchanged };
}

// Simple ANSI color helpers
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export default defineCommand({
  meta: {
    name: 'diff',
    description: 'Compare tools generated from two OpenAPI specs',
  },
  args: {
    oldSpec: {
      type: 'positional',
      description: 'Path or URL to the old OpenAPI spec',
      required: true,
    },
    newSpec: {
      type: 'positional',
      description: 'Path or URL to the new OpenAPI spec',
      required: true,
    },
    format: {
      type: 'string',
      description: 'Output format: "text" (default) or "json"',
      default: 'text',
    },
  },
  async run({ args }) {
    const oldSpec = args.oldSpec;
    const newSpec = args.newSpec;

    logger.info(`Comparing specs...`);
    logger.info(`  Old: ${oldSpec}`);
    logger.info(`  New: ${newSpec}`);

    const [oldLoad, newLoad] = await Promise.all([
      loadOpenApiSpec(oldSpec),
      loadOpenApiSpec(newSpec),
    ]);

    const oldOps = extractOperations(oldLoad.api as OpenAPIV3.Document);
    const newOps = extractOperations(newLoad.api as OpenAPIV3.Document);

    const oldTools = buildAllTools(oldOps.operations);
    const newTools = buildAllTools(newOps.operations);

    const result = diffTools(oldTools, newTools);

    if (args.format === 'json') {
      console.log(
        JSON.stringify(
          {
            added: result.added.map((t) => t.name),
            removed: result.removed.map((t) => t.name),
            changed: result.changed.map((c) => ({
              tool: c.tool.name,
              changes: c.changes,
            })),
            unchanged: result.unchanged,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log('');

    // Added
    if (result.added.length > 0) {
      console.log(green(`+ ${result.added.length} added tool(s):`));
      for (const tool of result.added) {
        console.log(
          green(`  + ${tool.name}`) + dim(` (${tool.method.toUpperCase()} ${tool.pathTemplate})`),
        );
      }
      console.log('');
    }

    // Removed
    if (result.removed.length > 0) {
      console.log(red(`- ${result.removed.length} removed tool(s):`));
      for (const tool of result.removed) {
        console.log(
          red(`  - ${tool.name}`) + dim(` (${tool.method.toUpperCase()} ${tool.pathTemplate})`),
        );
      }
      console.log('');
    }

    // Changed
    if (result.changed.length > 0) {
      console.log(yellow(`~ ${result.changed.length} changed tool(s):`));
      for (const { tool, changes } of result.changed) {
        console.log(yellow(`  ~ ${tool.name}`));
        for (const change of changes) {
          if (change.old && change.new) {
            console.log(`      ${change.field}: ${red(change.old)} -> ${green(change.new)}`);
          } else if (change.new) {
            console.log(`      ${change.field}: ${green(change.new)}`);
          } else {
            console.log(`      ${change.field}: ${red(change.old)}`);
          }
        }
      }
      console.log('');
    }

    // Summary
    const total =
      result.added.length + result.removed.length + result.changed.length + result.unchanged;
    console.log(
      `Summary: ${total} tools total — ${green(`${result.added.length} added`)}, ${red(`${result.removed.length} removed`)}, ${yellow(`${result.changed.length} changed`)}, ${result.unchanged} unchanged`,
    );
  },
});
