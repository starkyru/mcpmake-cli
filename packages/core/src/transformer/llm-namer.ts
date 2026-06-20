import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type { OperationDescriptor } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Structured-output schema for the naming response. Using a strict schema means
 * the model is constrained to return valid, parseable JSON of exactly this
 * shape — no markdown fences, no prose, no hand-rolled extraction. Flat (no
 * recursion), so it is fully supported by the structured-outputs API.
 */
const NAMING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['improvements'],
  properties: {
    improvements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'operationId', 'summary'],
        properties: {
          index: { type: 'integer' },
          operationId: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
} as const;

/**
 * Use Claude to generate better tool names and descriptions
 * from HAR-captured request/response patterns.
 */
export async function improveToolNames(
  operations: OperationDescriptor[],
  model?: string,
): Promise<OperationDescriptor[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set — skipping LLM tool naming');
    return operations;
  }

  const client = new Anthropic({ apiKey });

  const operationSummaries = operations.map((op) => ({
    method: op.method,
    path: op.path,
    currentId: op.operationId,
    summary: op.summary,
    paramNames: op.parameters.map((p) => p.name),
    hasBody: !!op.requestBody,
    tags: op.tags,
  }));

  const prompt = `Given these API operations captured from network traffic, suggest better operationId names and descriptions. Return one object per operation with its zero-based "index" in the list below, a camelCase "operationId" (under 40 chars), and a one-line "summary".

Operations:
${JSON.stringify(operationSummaries, null, 2)}`;

  try {
    logger.info('Improving tool names with Claude...');
    const message = await client.messages.parse({
      model: model ?? 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: jsonSchemaOutputFormat(NAMING_SCHEMA) },
    });

    const parsed = message.parsed_output;
    if (!parsed) return operations;

    const improvements = parsed.improvements;
    const result = operations.map((op, i) => {
      const improvement = improvements.find((imp) => imp.index === i);
      if (!improvement) return op;
      return {
        ...op,
        operationId: improvement.operationId || op.operationId,
        summary: improvement.summary || op.summary,
      };
    });

    logger.info(`Improved ${improvements.length} tool names`);
    return result;
  } catch (err) {
    logger.warn(`LLM naming failed, using defaults: ${err instanceof Error ? err.message : err}`);
    return operations;
  }
}
