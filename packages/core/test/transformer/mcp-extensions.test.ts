import { describe, it, expect } from 'vitest';
import { buildToolDefinition, buildAllTools } from '../../src/transformer/tool-builder.js';
import type { OperationDescriptor } from '../../src/types/index.js';

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'listPets',
    method: 'get',
    path: '/pets',
    tags: ['pets'],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

describe('x-mcp-* extensions', () => {
  it('uses x-mcp-name override', () => {
    const tool = buildToolDefinition(makeOp({ mcpExtensions: { name: 'fetch_all_pets' } }));
    expect(tool.name).toBe('fetch_all_pets');
    expect(tool.title).toBe('fetch_all_pets');
  });

  it('uses x-mcp-description override', () => {
    const tool = buildToolDefinition(
      makeOp({
        summary: 'Original summary',
        mcpExtensions: { description: 'Custom MCP description' },
      }),
    );
    expect(tool.description).toBe('Custom MCP description');
  });

  it('filters out x-mcp-emit: skip', () => {
    const ops = [
      makeOp({ operationId: 'listPets' }),
      makeOp({ operationId: 'internalDebug', mcpExtensions: { emit: 'skip' } }),
      makeOp({ operationId: 'createPet', method: 'post' }),
    ];
    const tools = buildAllTools(ops);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.operationId)).not.toContain('internalDebug');
  });

  it('works without extensions', () => {
    const tool = buildToolDefinition(makeOp());
    expect(tool.name).toBe('list_pets');
  });
});
