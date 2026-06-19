import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                openapi: '3.0.0',
                info: { title: 'Test API', version: '1.0.0' },
                servers: [{ url: 'https://api.test.com' }],
                paths: {
                  '/items': {
                    get: {
                      operationId: 'listItems',
                      summary: 'List items',
                      responses: {
                        '200': {
                          description: 'OK',
                          content: {
                            'application/json': {
                              schema: { type: 'array', items: { type: 'object' } },
                            },
                          },
                        },
                      },
                    },
                    post: {
                      operationId: 'createItem',
                      summary: 'Create an item',
                      requestBody: {
                        required: true,
                        content: {
                          'application/json': {
                            schema: {
                              type: 'object',
                              properties: { name: { type: 'string' } },
                              required: ['name'],
                            },
                          },
                        },
                      },
                      responses: { '201': { description: 'Created' } },
                    },
                  },
                },
              }),
            },
          ],
        }),
      },
    })),
  };
});

describe('spec-generator', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('generates a valid OpenAPI spec JSON', async () => {
    const { generateSpecFromDescription } = await import('../../src/generator/spec-generator.js');
    const json = await generateSpecFromDescription({
      description: 'A simple item management API',
    });

    const spec = JSON.parse(json);
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toBe('Test API');
    expect(spec.paths['/items']).toBeDefined();
    expect(spec.paths['/items'].get.operationId).toBe('listItems');
  });

  it('throws without ANTHROPIC_API_KEY', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { generateSpecFromDescription } = await import('../../src/generator/spec-generator.js');
    await expect(generateSpecFromDescription({ description: 'test' })).rejects.toThrow(
      'ANTHROPIC_API_KEY',
    );
  });
});
