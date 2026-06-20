import Anthropic from '@anthropic-ai/sdk';
import type { OperationDescriptor } from '../types/index.js';
import { logger } from '../utils/logger.js';

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

  const prompt = `Given these API operations captured from network traffic, suggest better operationId names and descriptions. Return a JSON array with one object per operation: { "index": number, "operationId": "camelCase name", "summary": "one-line description" }. Keep names concise (camelCase, under 40 chars). Only output JSON, no explanation.

Operations:
${JSON.stringify(operationSummaries, null, 2)}`;

  try {
    logger.info('Improving tool names with Claude...');
    const message = await client.messages.create({
      model: model ?? 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = message.content[0];
    if (content.type !== 'text') return operations;

    let json = content.text.trim();
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const improvements: Array<{ index: number; operationId: string; summary: string }> =
      JSON.parse(json);

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
