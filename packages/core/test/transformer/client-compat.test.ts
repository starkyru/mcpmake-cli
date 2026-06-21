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
    // 62-char names: both exceed cursor's 60-char limit and slice to the
    // SAME 60-char string ('a'*60), so the dedup branch in the source MUST fire.
    const prefix = 'a'.repeat(60);
    const tools = [makeTool(`${prefix}_1`), makeTool(`${prefix}_2`)];
    const result = applyClientCompat(tools, 'cursor');
    const names = result.map((t) => t.name);
    // Distinct (dedup happened) — this would FAIL if the dedup logic were removed,
    // because both would collapse to the identical truncated 'a'*60.
    expect(new Set(names).size).toBe(2);
    expect(names[0]).not.toBe(names[1]);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(60);
    }
    // Hand-computed expectations (method 'get' → '_get' suffix; max base 56):
    //   tool 1 → 'a'*56 + '_get'           (60 chars)
    //   tool 2 collides, gets counter '_2' → ('a'*56 + '_get').slice(0,58) + '_2'
    expect(names[0]).toBe('a'.repeat(56) + '_get');
    expect(names[1]).toBe('a'.repeat(56) + '_g' + '_2');
  });

  it('claude truncates names that exceed the 128-char limit', () => {
    const name = 'a'.repeat(150);
    const tools = [makeTool(name)];
    const result = applyClientCompat(tools, 'claude');
    // Proves claude truncates at exactly 128 (not unbounded, and not cursor's 60).
    expect(result[0].name.length).toBe(128);
    expect(result[0].name).toBe('a'.repeat(128));
  });

  it('claude does NOT inherit cursor 60-char limit for sub-128 names', () => {
    // 100 chars: under claude's 128 limit but well over cursor's 60. Must be left intact.
    const name = 'a'.repeat(100);
    const tools = [makeTool(name)];
    const result = applyClientCompat(tools, 'claude');
    expect(result[0].name).toBe('a'.repeat(100));
    expect(result[0].name.length).toBe(100);
  });

  it('guarantees distinct names when two tools truncate identically and share method POST (R3-2)', () => {
    // Inputs are 61 chars (cursor limit 60). They differ only in the final digit,
    // which gets cut off, so BOTH truncate to the same 60-char string ('a'*58 + '_x').
    // They also share HTTP method `post`, so the naive `_post` suffix produces the
    // same collision-resolution candidate for both — the fix must further disambiguate.
    const base = 'a'.repeat(58);
    const tools = [
      makeToolWithMethod(`${base}_x1`, 'post'), // 61 chars → truncates to 'a'*58 + '_x'
      makeToolWithMethod(`${base}_x2`, 'post'), // 61 chars → truncates to the SAME string
    ];
    const result = applyClientCompat(tools, 'cursor');
    const names = result.map((t) => t.name);
    expect(new Set(names).size).toBe(2); // no collision
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(60);
    }
    // Hand-computed: method 'post' → '_post' (5 chars), max base 55.
    //   tool 1 → 'a'*55 + '_post'                       (60 chars)
    //   tool 2 collides → ('a'*55 + '_post').slice(0,58) + '_2' = 'a'*55 + '_po' + '_2'
    expect(names[0]).toBe('a'.repeat(55) + '_post');
    expect(names[1]).toBe('a'.repeat(55) + '_po' + '_2');
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
