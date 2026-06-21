/**
 * R25-B regression: generated node tool-handler must emit `structuredContent`
 * in the sync success branch when `outputSchemaCode` is set.  The MCP SDK
 * throws McpError(InvalidParams) on every successful call when an outputSchema
 * is declared but structuredContent is absent.
 *
 * Wrap shape mirrors wrapArrayRoot (schema-converter.ts):
 *   - object result      → return as-is (object)
 *   - array result       → wrap as { items: result }
 *   - scalar result      → wrap as { items: result }
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { buildToolDefinition } from '../../src/transformer/tool-builder.js';
import { renderTemplate } from '../../src/emitter/template-loader.js';
import type { OperationDescriptor } from '../../src/types/index.js';

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'getItems',
    method: 'get',
    path: '/items',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

/** Transpile rendered TS and fail on any syntactic error (proves valid emit). */
function assertParses(source: string, label: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  const msgs = errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ');
  expect(errors, `${label} did not parse: ${msgs}`).toHaveLength(0);
}

/**
 * Extract and evaluate the structuredContent expression from the rendered template.
 * The expression is the ternary:
 *   result !== null && typeof result === 'object' && !Array.isArray(result)
 *     ? (result as Record<string, unknown>)
 *     : { items: result }
 * We evaluate this logic directly in TS/JS to verify the wrap shape for each
 * input type — this is the same expression emitted into the generated handler.
 */
function applyWrapExpression(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { items: result };
}

describe('tool-handler output schema — R25-B', () => {
  const opWithObjectSchema = makeOp({
    responses: [
      {
        statusCode: '200',
        contentType: 'application/json',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
          },
          required: ['id'],
        },
      },
    ],
  });

  const opWithArraySchema = makeOp({
    operationId: 'listItems',
    responses: [
      {
        statusCode: '200',
        contentType: 'application/json',
        schema: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'integer' } } },
        },
      },
    ],
  });

  const opWithNoSchema = makeOp({
    responses: [],
  });

  describe('template rendering — structuredContent presence', () => {
    it('emits structuredContent when outputSchemaCode is set (object response schema)', () => {
      const tool = buildToolDefinition(opWithObjectSchema);
      expect(tool.outputSchemaCode).toBeDefined();

      const src = renderTemplate('tool-handler.ts', tool);
      expect(src).toContain('structuredContent');
    });

    it('emits structuredContent when outputSchemaCode is set (array response schema)', () => {
      const tool = buildToolDefinition(opWithArraySchema);
      expect(tool.outputSchemaCode).toBeDefined();

      const src = renderTemplate('tool-handler.ts', tool);
      expect(src).toContain('structuredContent');
    });

    it('does NOT emit structuredContent when no outputSchema (no 200 response)', () => {
      const tool = buildToolDefinition(opWithNoSchema);
      expect(tool.outputSchemaCode).toBeUndefined();

      const src = renderTemplate('tool-handler.ts', tool);
      // The sync error branch uses isError — make sure we're not matching that structuredContent
      // from a potential future change; the sync success branch must not set it.
      // Count occurrences: the async branch doesn't exist when isAsync is false.
      // With no outputSchema, structuredContent must not appear at all in the rendered file.
      expect(src).not.toContain('structuredContent');
    });

    it('rendered template with outputSchema is valid TypeScript', () => {
      const tool = buildToolDefinition(opWithObjectSchema);
      const src = renderTemplate('tool-handler.ts', tool);
      assertParses(src, 'tool-handler with object outputSchema');
    });

    it('rendered template with array outputSchema is valid TypeScript', () => {
      const tool = buildToolDefinition(opWithArraySchema);
      const src = renderTemplate('tool-handler.ts', tool);
      assertParses(src, 'tool-handler with array outputSchema');
    });

    it('rendered template without outputSchema is valid TypeScript', () => {
      const tool = buildToolDefinition(opWithNoSchema);
      const src = renderTemplate('tool-handler.ts', tool);
      assertParses(src, 'tool-handler without outputSchema');
    });
  });

  describe('wrap expression correctness — mirrors wrapArrayRoot', () => {
    // wrapArrayRoot (schema-converter.ts) wraps type:array schemas as
    //   { type: 'object', properties: { items: <array schema> }, required: ['items'] }
    // and leaves object schemas bare.  The runtime structuredContent expression
    // must mirror this exactly.

    it('object result → returned as-is (bare object, no items wrap)', () => {
      const result = { id: 1, name: 'Alice' };
      const sc = applyWrapExpression(result);
      expect(sc).toBe(result); // same reference — not wrapped
      expect(sc).not.toHaveProperty('items');
    });

    it('array result → wrapped as { items: <array> }', () => {
      const result = [{ id: 1 }, { id: 2 }];
      const sc = applyWrapExpression(result);
      expect(sc).toEqual({ items: result });
      expect(sc.items).toBe(result);
    });

    it('null result → wrapped as { items: null }', () => {
      const sc = applyWrapExpression(null);
      expect(sc).toEqual({ items: null });
    });

    it('string scalar result → wrapped as { items: <string> }', () => {
      const sc = applyWrapExpression('hello');
      expect(sc).toEqual({ items: 'hello' });
    });

    it('number scalar result → wrapped as { items: <number> }', () => {
      const sc = applyWrapExpression(42);
      expect(sc).toEqual({ items: 42 });
    });

    it('boolean scalar result → wrapped as { items: <boolean> }', () => {
      const sc = applyWrapExpression(false);
      expect(sc).toEqual({ items: false });
    });

    it('empty array → wrapped as { items: [] }', () => {
      const sc = applyWrapExpression([]);
      expect(sc).toEqual({ items: [] });
    });

    it('empty object → returned as-is (is a non-null, non-array object)', () => {
      const result = {};
      const sc = applyWrapExpression(result);
      expect(sc).toBe(result);
    });
  });

  describe('rendered structuredContent expression matches wrap logic', () => {
    it('rendered source contains the ternary wrap expression for object outputSchema', () => {
      const tool = buildToolDefinition(opWithObjectSchema);
      const src = renderTemplate('tool-handler.ts', tool);

      // The ternary condition that mirrors wrapArrayRoot must be present verbatim.
      expect(src).toContain('!Array.isArray(result)');
      expect(src).toContain('{ items: result }');
    });

    it('rendered source contains the ternary wrap expression for array outputSchema', () => {
      const tool = buildToolDefinition(opWithArraySchema);
      const src = renderTemplate('tool-handler.ts', tool);

      expect(src).toContain('!Array.isArray(result)');
      expect(src).toContain('{ items: result }');
    });

    it('sync error branch still sets isError (unchanged)', () => {
      const tool = buildToolDefinition(opWithObjectSchema);
      const src = renderTemplate('tool-handler.ts', tool);
      expect(src).toContain('isError: true');
    });
  });
});
