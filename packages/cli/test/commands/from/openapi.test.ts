/**
 * Tests for the `openapi` command's --static-tools handling (A4-7).
 *
 * The guard against silently coercing bad --static-tools input lives in the
 * shared helper parseIntFlag (website.ts) and its in-isolation contract is
 * exercised exhaustively by website.test.ts. What is NOT covered there — and is
 * what actually ships in `mcpmake from openapi` — is the *call site*:
 *
 *   const staticToolCount = args['static-tools']
 *     ? parseIntFlag(args['static-tools'], 'static-tools', 0)
 *     : undefined;                                    // openapi.ts:239-241
 *
 * That truthy guard means an unset OR empty `--static-tools` yields `undefined`
 * (NOT 0), and a present-but-bad value must surface the guard's error rather
 * than reach the emitter. These tests drive the real command end to end and
 * assert how the flag threads into the manifest handed to emitProject.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseIntFlag } from '../../../src/commands/from/website.js';

// Capture the manifest handed to emitProject so we can assert how --static-tools
// and --dynamic-discovery thread into staticToolCount, without parsing a real spec.
const emitCalls: { manifest: Record<string, unknown> }[] = [];

vi.mock('@mcpmake/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcpmake/core')>();
  const operations = [
    { operationId: 'listThings', method: 'get', path: '/things', summary: 'List things' },
  ];
  const tool = {
    name: 'list_things',
    title: 'List things',
    description: 'List things',
    inputSchemaCode: 'z.object({})',
    fileName: 'list-things',
    functionName: 'listThings',
    annotations: {},
  };
  return {
    ...actual,
    loadOpenApiSpec: vi.fn(async () => ({ api: { openapi: '3.0.0' } })),
    extractOperations: vi.fn(() => ({
      operations,
      baseUrl: 'https://api.example.com',
      securitySchemes: {},
      info: { title: 'Example API', version: '2.1.0' },
    })),
    detectAuthSchemes: vi.fn(() => ({ authSchemes: [], envVars: [] })),
    buildAllTools: vi.fn(() => [tool]),
    filterOperations: vi.fn((ops: unknown) => ops),
    buildResources: vi.fn(() => []),
    buildPrompts: vi.fn(() => []),
    emitProject: vi.fn(async (manifest: Record<string, unknown>) => {
      emitCalls.push({ manifest });
    }),
    emitPythonProject: vi.fn(async (manifest: Record<string, unknown>) => {
      emitCalls.push({ manifest });
    }),
  };
});

describe('openapi command — --static-tools / staticToolCount plumbing (A4-7)', () => {
  let openapiCommand: { run?: (ctx: { args: Record<string, unknown> }) => Promise<unknown> };

  beforeEach(async () => {
    emitCalls.length = 0;
    openapiCommand = (await import('../../../src/commands/from/openapi.js'))
      .default as typeof openapiCommand;
  });

  const baseArgs = (overrides: Record<string, unknown>) => ({
    spec: 'https://api.example.com/openapi.json',
    output: '/tmp/does-not-matter',
    'dry-run': true,
    force: false,
    ...overrides,
  });

  it('parses a valid --static-tools into manifest.staticToolCount', async () => {
    await openapiCommand.run!({
      args: baseArgs({ 'dynamic-discovery': true, 'static-tools': '3' }),
    });

    expect(emitCalls).toHaveLength(1);
    const manifest = emitCalls[0].manifest;
    expect(manifest.staticToolCount).toBe(3);
    expect(manifest.dynamicDiscovery).toBe(true);
  });

  it('leaves staticToolCount undefined when --static-tools is omitted (truthy guard short-circuits)', async () => {
    await openapiCommand.run!({ args: baseArgs({ 'dynamic-discovery': true }) });

    expect(emitCalls).toHaveLength(1);
    // The call site is `args['static-tools'] ? parseIntFlag(...) : undefined`,
    // so an absent flag never calls parseIntFlag and yields undefined — NOT 0.
    expect(emitCalls[0].manifest.staticToolCount).toBeUndefined();
  });

  it('leaves staticToolCount undefined for an empty --static-tools (empty string is falsy)', async () => {
    await openapiCommand.run!({
      args: baseArgs({ 'dynamic-discovery': true, 'static-tools': '' }),
    });

    expect(emitCalls).toHaveLength(1);
    // '' is falsy, so the guard skips parseIntFlag entirely: the manifest gets
    // undefined, not the helper's 0 fallback. (Earlier docs claimed 0 here.)
    expect(emitCalls[0].manifest.staticToolCount).toBeUndefined();
  });

  it('accepts --static-tools 0 (explicit zero is a real value, not the unset sentinel)', async () => {
    await openapiCommand.run!({
      args: baseArgs({ 'dynamic-discovery': true, 'static-tools': '0' }),
    });

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].manifest.staticToolCount).toBe(0);
  });

  it('rejects a non-numeric --static-tools before reaching the emitter', async () => {
    await expect(
      openapiCommand.run!({
        args: baseArgs({ 'dynamic-discovery': true, 'static-tools': 'abc' }),
      }),
    ).rejects.toThrow(/Invalid --static-tools/);

    // The guard fires inside run(); emitProject must never see a NaN manifest.
    expect(emitCalls).toHaveLength(0);
  });

  it('rejects a negative --static-tools before reaching the emitter', async () => {
    await expect(
      openapiCommand.run!({
        args: baseArgs({ 'dynamic-discovery': true, 'static-tools': '-1' }),
      }),
    ).rejects.toThrow(/Invalid --static-tools/);
    expect(emitCalls).toHaveLength(0);
  });
});

// One focused helper case that website.test.ts does NOT cover: parseInt('0x', 10)
// returns 0, but the flag would be silently mis-accepted. parseIntFlag uses
// Number('0x') === NaN, so it correctly throws. (All other helper contracts —
// undefined/'' fallback, '5', '0', 'abc', '-3', '2.5' — are owned by website.test.ts.)
describe('parseIntFlag — hex-prefix edge not covered by website.test.ts', () => {
  it('rejects "0x" that bare parseInt(…, 10) would accept as 0', () => {
    expect(() => parseIntFlag('0x', 'static-tools', 0)).toThrow(/Invalid --static-tools/);
  });
});
