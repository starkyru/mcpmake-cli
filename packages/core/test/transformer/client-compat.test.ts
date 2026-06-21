import { describe, it, expect } from 'vitest';
import { applyClientCompat } from '../../src/transformer/client-compat.js';
import type { ToolDefinition } from '../../src/types/index.js';

function makeToolWithMethod(name: string, method: ToolDefinition['method']): ToolDefinition {
  return {
    name,
    title: name,
    description: 'test',
    inputSchemaCode: 'z.object({})',
    operationId: name,
    method,
    pathTemplate: '/test',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    paramMappings: [],
    hasRequestBody: false,
    requestBodyContentType: 'application/json',
    buildHeadersBody: '  return {};',
    operationMeta: `{"method":"${method}","path":"/test"}`,
    fileName: name,
    functionName: name,
    buildUrlBody: '  return url;',
  };
}

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
    paramMappings: [],
    hasRequestBody: false,
    requestBodyContentType: 'application/json',
    buildHeadersBody: '  return {};',
    operationMeta: '{"method":"get","path":"/test"}',
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

  it('guarantees distinct names when two tools truncate identically and share method POST (R3-2)', () => {
    // Both names are 62 chars (cursor limit 60) and truncate to the same 60-char base.
    // They also share HTTP method `post`, so the naive `_post` suffix produces the
    // same collision-resolution candidate for both — the fix must further disambiguate.
    const base = 'a'.repeat(58); // 58 chars — leaves room for truncation at 60
    const tools = [
      makeToolWithMethod(`${base}_x1`, 'post'), // truncates to base + '_x' → same 60 chars? let's use exact collision
      makeToolWithMethod(`${base}_x2`, 'post'),
    ];
    // Both truncate to `aaa...aaa_x` (58 + '_x' = 60 chars) for cursor's limit of 60,
    // but the two originals differ only in the last character which gets cut off.
    // Verify: names are distinct AND within the limit.
    const result = applyClientCompat(tools, 'cursor');
    const names = result.map((t) => t.name);
    expect(new Set(names).size).toBe(2); // no collision
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(60);
    }
  });

  it('guarantees distinct names for N > 2 identical-truncation same-method tools (R3-2)', () => {
    // Three tools that all truncate to the same 60-char name and share method `post`.
    const base = 'b'.repeat(60);
    const tools = [
      makeToolWithMethod(`${base}A`, 'post'),
      makeToolWithMethod(`${base}B`, 'post'),
      makeToolWithMethod(`${base}C`, 'post'),
    ];
    const result = applyClientCompat(tools, 'cursor');
    const names = result.map((t) => t.name);
    expect(new Set(names).size).toBe(3);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(60);
    }
  });
});
