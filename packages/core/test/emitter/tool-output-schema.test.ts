/**
 * R25-B / R26-A / R26-B regressions: generated node tool-handler must emit
 * `structuredContent` in the sync success branch when `outputSchemaCode` is set,
 * and the shape must mirror wrapArrayRoot (schema-converter.ts) exactly.
 *
 * R26-A (scalar mismatch): wrapArrayRoot passes OBJECTS and SCALARS through bare
 * and wraps ONLY arrays as { items: <array> }.  The runtime structuredContent
 * expression must do the same — NOT wrap scalars in { items }.
 *
 * R26-B (async + output schema): when an op has BOTH a 202 (isAsync) AND a 200
 * schema (outputSchemaCode), registering outputSchema causes SDK validation to
 * fail on every call because the async task-envelope { task: { taskId, status } }
 * never matches the 200 body schema.  Fix: suppress outputSchema registration
 * (and the const declaration) when isAsync.
 *
 * Wrap shape mirrors wrapArrayRoot (schema-converter.ts):
 *   - array result       → wrap as { items: result }
 *   - object result      → return as-is (bare object)
 *   - scalar result      → return as-is (bare scalar)
 *   - null result        → return as-is (null; cast for TS)
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
 * R26-A corrected wrap logic — mirrors wrapArrayRoot exactly:
 *   array  → { items: result }
 *   object → bare (as-is)
 *   scalar → bare (as-is, cast to Record<string,unknown> for TS)
 *   null   → bare (as-is, cast to Record<string,unknown> for TS)
 *
 * NOTE: this is the NEW expression emitted into the generated handler after R26-A.
 * The previous (broken) expression wrapped all non-object values in { items }.
 */
function applyWrapExpression(result: unknown): unknown {
  return Array.isArray(result) ? { items: result } : (result as unknown as Record<string, unknown>);
}

describe('tool-handler output schema — R25-B / R26-A / R26-B', () => {
  // --- Op fixtures ----------------------------------------------------------

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

  const opWithStringSchema = makeOp({
    operationId: 'getToken',
    responses: [
      {
        statusCode: '200',
        contentType: 'application/json',
        schema: { type: 'string' },
      },
    ],
  });

  const opWithNumberSchema = makeOp({
    operationId: 'getCount',
    responses: [
      {
        statusCode: '200',
        contentType: 'application/json',
        schema: { type: 'number' },
      },
    ],
  });

  const opWithBoolSchema = makeOp({
    operationId: 'getFlag',
    responses: [
      {
        statusCode: '200',
        contentType: 'application/json',
        schema: { type: 'boolean' },
      },
    ],
  });

  const opWithNoSchema = makeOp({
    responses: [],
  });

  /**
   * R26-B: op with BOTH 202 (async) AND 200 body schema.
   * buildToolDefinition: isAsync=true (202 present), outputSchemaCode set (200 present).
   * The async branch must NOT register outputSchema.
   */
  const opAsyncWithOutputSchema = makeOp({
    operationId: 'startJob',
    method: 'post',
    responses: [
      {
        statusCode: '202',
        description: 'Accepted',
      },
      {
        statusCode: '200',
        contentType: 'application/json',
        schema: {
          type: 'object',
          properties: { jobId: { type: 'string' } },
          required: ['jobId'],
        },
      },
    ],
  });

  // --- Template rendering — structuredContent presence ---------------------

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

    it('emits structuredContent when outputSchemaCode is set (string scalar response schema)', () => {
      const tool = buildToolDefinition(opWithStringSchema);
      expect(tool.outputSchemaCode).toBeDefined();

      const src = renderTemplate('tool-handler.ts', tool);
      expect(src).toContain('structuredContent');
    });

    it('does NOT emit structuredContent when no outputSchema (no 200 response)', () => {
      const tool = buildToolDefinition(opWithNoSchema);
      expect(tool.outputSchemaCode).toBeUndefined();

      const src = renderTemplate('tool-handler.ts', tool);
      // With no outputSchema and no async (no async branch either), structuredContent
      // must not appear at all in the rendered file.
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

    it('rendered template with string scalar outputSchema is valid TypeScript', () => {
      const tool = buildToolDefinition(opWithStringSchema);
      const src = renderTemplate('tool-handler.ts', tool);
      assertParses(src, 'tool-handler with string outputSchema');
    });

    it('rendered template with number scalar outputSchema is valid TypeScript', () => {
      const tool = buildToolDefinition(opWithNumberSchema);
      const src = renderTemplate('tool-handler.ts', tool);
      assertParses(src, 'tool-handler with number outputSchema');
    });

    it('rendered template with boolean scalar outputSchema is valid TypeScript', () => {
      const tool = buildToolDefinition(opWithBoolSchema);
      const src = renderTemplate('tool-handler.ts', tool);
      assertParses(src, 'tool-handler with boolean outputSchema');
    });

    it('rendered template without outputSchema is valid TypeScript', () => {
      const tool = buildToolDefinition(opWithNoSchema);
      const src = renderTemplate('tool-handler.ts', tool);
      assertParses(src, 'tool-handler without outputSchema');
    });
  });

  // --- R26-A: wrap expression correctness — mirrors wrapArrayRoot ----------

  describe('R26-A: wrap expression correctness — mirrors wrapArrayRoot', () => {
    // wrapArrayRoot (schema-converter.ts) wraps ONLY type:array schemas:
    //   { type: 'object', properties: { items: <array schema> }, required: ['items'] }
    // Objects and scalars pass through unchanged.
    // The runtime structuredContent expression must mirror this exactly.

    it('object result → returned bare as-is (no items wrap)', () => {
      const result = { id: 1, name: 'Alice' };
      const sc = applyWrapExpression(result);
      expect(sc).toBe(result); // same reference — not wrapped
      expect(sc).not.toHaveProperty('items');
    });

    it('array result → wrapped as { items: <array> }', () => {
      const result = [{ id: 1 }, { id: 2 }];
      const sc = applyWrapExpression(result);
      expect(sc).toEqual({ items: result });
      expect((sc as Record<string, unknown>).items).toBe(result);
    });

    it('null result → returned bare (null, not { items: null })', () => {
      const sc = applyWrapExpression(null);
      // null is NOT an array → bare passthrough (null cast to Record for TS)
      expect(sc).toBeNull();
    });

    it('string scalar result → returned bare (not { items: "..." })', () => {
      const sc = applyWrapExpression('hello');
      expect(sc).toBe('hello');
    });

    it('number scalar result → returned bare (not { items: 42 })', () => {
      const sc = applyWrapExpression(42);
      expect(sc).toBe(42);
    });

    it('boolean scalar result → returned bare (not { items: false })', () => {
      const sc = applyWrapExpression(false);
      expect(sc).toBe(false);
    });

    it('empty array → wrapped as { items: [] }', () => {
      const sc = applyWrapExpression([]);
      expect(sc).toEqual({ items: [] });
    });

    it('empty object → returned bare as-is', () => {
      const result = {};
      const sc = applyWrapExpression(result);
      expect(sc).toBe(result);
    });
  });

  // --- R26-A: rendered expression form ------------------------------------

  describe('R26-A: rendered structuredContent expression uses Array.isArray form', () => {
    it('rendered source uses Array.isArray(result) ternary (object outputSchema)', () => {
      const tool = buildToolDefinition(opWithObjectSchema);
      const src = renderTemplate('tool-handler.ts', tool);

      // The NEW expression form: only arrays get { items }, everything else is bare.
      expect(src).toContain('Array.isArray(result)');
      expect(src).toContain('{ items: result }');
      // Must NOT use the old 3-condition form that would wrap scalars.
      expect(src).not.toContain("typeof result === 'object'");
    });

    it('rendered source uses Array.isArray(result) ternary (array outputSchema)', () => {
      const tool = buildToolDefinition(opWithArraySchema);
      const src = renderTemplate('tool-handler.ts', tool);

      expect(src).toContain('Array.isArray(result)');
      expect(src).toContain('{ items: result }');
    });

    it('rendered source uses Array.isArray(result) ternary (scalar outputSchema)', () => {
      const tool = buildToolDefinition(opWithStringSchema);
      const src = renderTemplate('tool-handler.ts', tool);

      expect(src).toContain('Array.isArray(result)');
      expect(src).toContain('{ items: result }');
      // Scalars now fall through to the bare passthrough branch.
      expect(src).not.toContain("typeof result === 'object'");
    });

    it('sync error branch still sets isError (unchanged)', () => {
      const tool = buildToolDefinition(opWithObjectSchema);
      const src = renderTemplate('tool-handler.ts', tool);
      expect(src).toContain('isError: true');
    });
  });

  // --- R26-B: async + outputSchema → no outputSchema registration ----------

  describe('R26-B: async op with outputSchema must NOT register outputSchema', () => {
    it('buildToolDefinition sets both isAsync and outputSchemaCode for 202+200 op', () => {
      const tool = buildToolDefinition(opAsyncWithOutputSchema);
      expect(tool.isAsync).toBe(true);
      expect(tool.outputSchemaCode).toBeDefined();
    });

    it('rendered async+outputSchema handler omits const outputSchema declaration', () => {
      const tool = buildToolDefinition(opAsyncWithOutputSchema);
      const src = renderTemplate('tool-handler.ts', tool);

      // The async branch MUST NOT declare const outputSchema — the task-envelope
      // { task: { taskId, status } } never matches the 200 body schema, causing
      // SDK validation to fail on every call.
      expect(src).not.toContain('const outputSchema');
    });

    it('rendered async+outputSchema handler omits outputSchema from registerTool config', () => {
      const tool = buildToolDefinition(opAsyncWithOutputSchema);
      const src = renderTemplate('tool-handler.ts', tool);

      // Must not register outputSchema with the MCP SDK.
      // Note: the async branch itself returns structuredContent: { task: handle }
      // which is a valid object; we just must not pass an outputSchema that
      // would validate it against the mismatched 200 body schema.
      expect(src).not.toContain('outputSchema,');
      expect(src).not.toContain('outputSchema:');
    });

    it('rendered async+outputSchema handler still returns task structuredContent', () => {
      const tool = buildToolDefinition(opAsyncWithOutputSchema);
      const src = renderTemplate('tool-handler.ts', tool);

      // The async branch's own structuredContent: { task: handle } must remain.
      expect(src).toContain('structuredContent: { task: handle }');
    });

    it('rendered async+outputSchema handler is valid TypeScript', () => {
      const tool = buildToolDefinition(opAsyncWithOutputSchema);
      const src = renderTemplate('tool-handler.ts', tool);
      assertParses(src, 'tool-handler async+outputSchema');
    });

    it('sync op with outputSchema DOES register const outputSchema', () => {
      const tool = buildToolDefinition(opWithObjectSchema);
      expect(tool.isAsync).toBeFalsy();

      const src = renderTemplate('tool-handler.ts', tool);
      expect(src).toContain('const outputSchema');
      expect(src).toContain('outputSchema,');
    });

    it('sync op with scalar outputSchema DOES register const outputSchema', () => {
      const tool = buildToolDefinition(opWithStringSchema);
      expect(tool.isAsync).toBeFalsy();

      const src = renderTemplate('tool-handler.ts', tool);
      expect(src).toContain('const outputSchema');
      expect(src).toContain('outputSchema,');
    });

    it('pure async op (only 202, no 200 schema) has no outputSchema at all', () => {
      const purAsync = makeOp({
        operationId: 'triggerJob',
        method: 'post',
        responses: [{ statusCode: '202', description: 'Accepted' }],
      });
      const tool = buildToolDefinition(purAsync);
      expect(tool.isAsync).toBe(true);
      expect(tool.outputSchemaCode).toBeUndefined();

      const src = renderTemplate('tool-handler.ts', tool);
      expect(src).not.toContain('const outputSchema');
      expect(src).not.toContain('outputSchema,');
    });

    it('async op with outputSchema omits sync structuredContent wrapping', () => {
      const tool = buildToolDefinition(opAsyncWithOutputSchema);
      const src = renderTemplate('tool-handler.ts', tool);

      // The Array.isArray ternary wrap only appears in the sync ({{else}}) branch.
      // When isAsync the else branch is not rendered at all.
      expect(src).not.toContain('Array.isArray(result)');
    });
  });
});
