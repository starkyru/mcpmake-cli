import { extractJsonObject } from '../utils/json-extract.js';
import { logger } from '../utils/logger.js';
import { requireLlmProvider } from '../llm/index.js';

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
  const provider = requireLlmProvider('describe mode');

  let userPrompt = `Generate an OpenAPI 3.0 spec for: ${options.description}`;
  if (options.baseUrl) {
    userPrompt += `\n\nUse this base URL: ${options.baseUrl}`;
  }

  logger.info('Generating OpenAPI spec from description...');

  const responseText = await provider.completeText({
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    tier: 'balanced',
    model: options.model,
    maxTokens: 4096,
  });

  // OpenAPI specs are recursive, so structured outputs can't enforce the shape.
  // Instead, extract the first balanced JSON object — robust to markdown fences,
  // leading/trailing prose, and braces that appear inside string values.
  const json = extractJsonObject(responseText);
  if (json === null) {
    throw new Error(
      'The model did not return a JSON object. Try again or refine your description.',
    );
  }

  // Validate it's parseable JSON
  try {
    JSON.parse(json);
  } catch {
    throw new Error('The model returned invalid JSON. Try again or refine your description.');
  }

  return json;
}
