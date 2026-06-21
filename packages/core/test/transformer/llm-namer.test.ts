import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OperationDescriptor } from '../../src/types/index.js';

const completeJsonMock = vi.fn();

vi.mock('../../src/llm/index.js', () => ({
  getLlmProvider: vi.fn().mockResolvedValue({
    name: 'anthropic',
    supportsVision: false,
    completeText: vi.fn(),
    completeJson: completeJsonMock,
  }),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'getUsers',
    method: 'get',
    path: '/users',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

describe('llm-namer (A4-4: non-array improvements guard)', () => {
  beforeEach(() => {
    completeJsonMock.mockReset();
  });

  it('applies improvements when LLM returns a valid array', async () => {
    completeJsonMock.mockResolvedValueOnce({
      improvements: [{ index: 0, operationId: 'listAllUsers', summary: 'Lists all users' }],
    });
    const { improveToolNames } = await import('../../src/transformer/llm-namer.js');
    const result = await improveToolNames([makeOp()]);
    expect(result[0].operationId).toBe('listAllUsers');
    expect(result[0].summary).toBe('Lists all users');
  });

  it('warns and returns originals when improvements is null (not an array)', async () => {
    completeJsonMock.mockResolvedValueOnce({ improvements: null });
    const { improveToolNames } = await import('../../src/transformer/llm-namer.js');
    const { logger } = await import('../../src/utils/logger.js');
    const op = makeOp();
    const result = await improveToolNames([op]);
    // Falls through to the catch → warns, returns unchanged operations.
    expect(result[0].operationId).toBe('getUsers');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('LLM returned unexpected improvements shape'),
    );
  });

  it('warns and returns originals when improvements is an object (not an array)', async () => {
    completeJsonMock.mockResolvedValueOnce({ improvements: { index: 0 } });
    const { improveToolNames } = await import('../../src/transformer/llm-namer.js');
    const { logger } = await import('../../src/utils/logger.js');
    const result = await improveToolNames([makeOp()]);
    expect(result[0].operationId).toBe('getUsers');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('LLM returned unexpected improvements shape'),
    );
  });

  it('returns originals when completeJson returns null', async () => {
    completeJsonMock.mockResolvedValueOnce(null);
    const { improveToolNames } = await import('../../src/transformer/llm-namer.js');
    const result = await improveToolNames([makeOp()]);
    expect(result[0].operationId).toBe('getUsers');
  });
});
