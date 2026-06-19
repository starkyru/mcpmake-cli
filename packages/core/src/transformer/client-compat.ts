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

  // Deduplicate after truncation
  const nameCount = new Map<string, number>();
  for (const t of result) {
    nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1);
  }
  for (const tool of result) {
    if ((nameCount.get(tool.name) ?? 0) > 1) {
      // Append a hash suffix to make unique, staying within limit
      const suffix = `_${tool.method}`;
      const maxBase = limits.maxToolNameLength - suffix.length;
      tool.name = tool.name.slice(0, maxBase) + suffix;
    }
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
