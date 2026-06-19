import { describe, it, expect } from 'vitest';
import { buildToolDefinition } from '../../src/transformer/tool-builder.js';
import type { OperationDescriptor } from '../../src/types/index.js';

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'testOp',
    method: 'get',
    path: '/test',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

describe('tool annotations', () => {
  it('marks GET as readOnly', () => {
    const tool = buildToolDefinition(makeOp({ method: 'get' }));
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('marks DELETE as destructive', () => {
    const tool = buildToolDefinition(makeOp({ method: 'delete' }));
    expect(tool.annotations?.destructiveHint).toBe(true);
  });

  it('marks PUT as idempotent', () => {
    const tool = buildToolDefinition(makeOp({ method: 'put' }));
    expect(tool.annotations?.idempotentHint).toBe(true);
  });

  it('no annotations for POST', () => {
    const tool = buildToolDefinition(makeOp({ method: 'post' }));
    expect(tool.annotations).toBeUndefined();
  });

  it('marks HEAD as readOnly', () => {
    const tool = buildToolDefinition(makeOp({ method: 'head' }));
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });
});

describe('tool outputSchema', () => {
  it('generates outputSchema from 200 response', () => {
    const tool = buildToolDefinition(
      makeOp({
        responses: [
          {
            statusCode: '200',
            contentType: 'application/json',
            schema: { type: 'object', properties: { id: { type: 'integer' } } },
          },
        ],
      }),
    );
    expect(tool.outputSchemaCode).toBeDefined();
    expect(tool.outputSchemaCode).toContain('z.object');
  });

  it('no outputSchema when no 200 response', () => {
    const tool = buildToolDefinition(makeOp({ responses: [] }));
    expect(tool.outputSchemaCode).toBeUndefined();
  });
});
