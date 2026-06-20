import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';

export interface GenerateSpecOptions {
  description: string;
  baseUrl?: string;
  model?: string;
}

const SYSTEM_PROMPT = `You are an API architect. Given a description of an API or service, generate a valid OpenAPI 3.0 specification in JSON format.

Rules:
- Output ONLY valid JSON (no markdown fences, no explanation)
- Include realistic endpoints with proper HTTP methods
- Use descriptive operationIds in camelCase
- Include request/response schemas with realistic field types
- Add path parameters, query parameters, and request bodies where appropriate
- Include at least one security scheme if auth is likely needed
- Include a servers array with a base URL
- Keep it practical — 3-10 operations is typical`;

export async function generateSpecFromDescription(options: GenerateSpecOptions): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required for describe mode.\n' +
        'Set it with: export ANTHROPIC_API_KEY=your-key-here',
    );
  }

  const client = new Anthropic({ apiKey });
  const model = options.model ?? 'claude-sonnet-4-6';

  let userPrompt = `Generate an OpenAPI 3.0 spec for: ${options.description}`;
  if (options.baseUrl) {
    userPrompt += `\n\nUse this base URL: ${options.baseUrl}`;
  }

  logger.info('Generating OpenAPI spec from description...');

  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response format from Claude');
  }

  // OpenAPI specs are recursive, so structured outputs can't enforce the shape.
  // Instead, extract the first balanced JSON object — robust to markdown fences,
  // leading/trailing prose, and braces that appear inside string values.
  const json = extractJsonObject(content.text);
  if (json === null) {
    throw new Error('Claude did not return a JSON object. Try again or refine your description.');
  }

  // Validate it's parseable JSON
  try {
    JSON.parse(json);
  } catch {
    throw new Error('Claude returned invalid JSON. Try again or refine your description.');
  }

  return json;
}

/**
 * Return the substring spanning the first balanced top-level `{...}` object in
 * `text`, or null if none. String-aware (ignores braces inside quoted strings)
 * and linear-time — no regex, so no catastrophic-backtracking risk.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}
