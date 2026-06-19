import { describe, it, expect } from 'vitest';
import { applyClientCompat } from '../../src/transformer/client-compat.js';
import type { ToolDefinition } from '../../src/types/index.js';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    title: name,
    description: 'test',
    inputSchemaCode: 'z.object({})',
    operationId: name,
    method: 'get',
    pathTemplate: '/test',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    hasRequestBody: false,
    requestBodyContentType: 'application/json',
    fileName: name,
    functionName: name,
    buildUrlBody: '  return url;',
  };
}

describe('client-compat', () => {
  it('truncates long tool names for cursor', () => {
    const longName = 'a'.repeat(80);
    const tools = [makeTool(longName)];
    const result = applyClientCompat(tools, 'cursor');
    expect(result[0].name.length).toBeLessThanOrEqual(60);
  });

  it('enforces cursor 40 tool limit', () => {
    const tools = Array.from({ length: 50 }, (_, i) => makeTool(`tool_${i}`));
    const result = applyClientCompat(tools, 'cursor');
    expect(result.length).toBe(40);
  });

  it('does not truncate short names', () => {
    const tools = [makeTool('list_pets')];
    const result = applyClientCompat(tools, 'cursor');
    expect(result[0].name).toBe('list_pets');
  });

  it('deduplicates after truncation', () => {
    const prefix = 'a'.repeat(58);
    const tools = [makeTool(`${prefix}_1`), makeTool(`${prefix}_2`)];
    const result = applyClientCompat(tools, 'cursor');
    const names = result.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('claude mode allows longer names', () => {
    const name = 'a'.repeat(100);
    const tools = [makeTool(name)];
    const result = applyClientCompat(tools, 'claude');
    expect(result[0].name.length).toBeLessThanOrEqual(128);
  });
});
