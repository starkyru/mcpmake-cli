import { describe, it, expect } from 'vitest';
import { registerAdapter, getAdapter, listAdapters } from '../../src/plugins/loader.js';
import type { McpmakeAdapter } from '../../src/plugins/adapter.js';

describe('plugin system', () => {
  it('registers and retrieves an adapter', () => {
    const mockAdapter: McpmakeAdapter = {
      name: 'test-adapter',
      description: 'Test adapter',
      extensions: ['.test'],
      parse: async () => ({
        operations: [],
        baseUrl: 'https://test.com',
        authSchemes: [],
        envVars: [],
        info: { title: 'Test', version: '1.0.0' },
      }),
    };

    registerAdapter(mockAdapter);
    expect(getAdapter('test-adapter')).toBeDefined();
    expect(getAdapter('test-adapter')?.name).toBe('test-adapter');
  });

  it('lists all registered adapters', () => {
    const before = listAdapters().length;
    registerAdapter({
      name: 'list-test',
      description: 'List test',
      parse: async () => ({
        operations: [],
        baseUrl: '',
        authSchemes: [],
        envVars: [],
        info: { title: 'Test', version: '1.0.0' },
      }),
    });
    expect(listAdapters().length).toBeGreaterThanOrEqual(before + 1);
  });

  it('returns undefined for unknown adapter', () => {
    expect(getAdapter('nonexistent')).toBeUndefined();
  });
});
