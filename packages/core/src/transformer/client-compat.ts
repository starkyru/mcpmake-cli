import type { ToolDefinition } from '../types/index.js';
import { logger } from '../utils/logger.js';

export type ClientMode = 'cursor' | 'claude' | 'openai';

interface ClientLimits {
  maxToolNameLength: number;
  maxTools: number;
}

const CLIENT_LIMITS: Record<ClientMode, ClientLimits> = {
  cursor: { maxToolNameLength: 60, maxTools: 40 },
  claude: { maxToolNameLength: 128, maxTools: 1000 },
  openai: { maxToolNameLength: 128, maxTools: 128 },
};

/**
 * Apply client-specific compatibility transforms to tool definitions.
 */
export function applyClientCompat(tools: ToolDefinition[], client: ClientMode): ToolDefinition[] {
  const limits = CLIENT_LIMITS[client];
  let result = tools.map((t) => ({ ...t }));

  // Truncate tool names to client limit
  const renamed = new Map<string, string>();
  for (const tool of result) {
    if (tool.name.length > limits.maxToolNameLength) {
      const original = tool.name;
      tool.name = tool.name.slice(0, limits.maxToolNameLength);
      renamed.set(original, tool.name);
    }
  }

  // Deduplicate after truncation — guarantee uniqueness even when two tools
  // truncate to the same name AND share the same HTTP method.
  const nameCount = new Map<string, number>();
  for (const t of result) {
    nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1);
  }
  const claimedNames = new Set<string>(
    result.filter((t) => (nameCount.get(t.name) ?? 0) === 1).map((t) => t.name),
  );
  for (const tool of result) {
    if ((nameCount.get(tool.name) ?? 0) <= 1) continue;
    // Build a candidate: truncated base + method suffix, then increment counter
    // until unique, all within the length limit.
    const methodSuffix = `_${tool.method}`;
    const maxBase = limits.maxToolNameLength - methodSuffix.length;
    const base = tool.name.slice(0, maxBase) + methodSuffix;
    let candidate = base;
    for (let n = 2; claimedNames.has(candidate); n++) {
      const counterSuffix = `_${n}`;
      const cappedBase = base.slice(0, limits.maxToolNameLength - counterSuffix.length);
      candidate = cappedBase + counterSuffix;
    }
    claimedNames.add(candidate);
    tool.name = candidate;
  }

  if (renamed.size > 0) {
    logger.warn(
      `[${client}] Truncated ${renamed.size} tool name(s) to ${limits.maxToolNameLength} chars`,
    );
  }

  // Enforce max tool count
  if (result.length > limits.maxTools) {
    logger.warn(
      `[${client}] Tool count (${result.length}) exceeds limit (${limits.maxTools}). Keeping first ${limits.maxTools}.`,
    );
    result = result.slice(0, limits.maxTools);
  }

  return result;
}
