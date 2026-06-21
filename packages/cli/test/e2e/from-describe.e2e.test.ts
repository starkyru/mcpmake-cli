/**
 * Sprint E5 — `mcpmake from describe` end-to-end (LLM-driven, mock provider).
 *
 * `from describe` turns a natural-language prompt into an OpenAPI spec via an
 * LLM, then runs that spec through the same generate pipeline as `from openapi`.
 * The unit tier (describe.test.ts) mocks `@mcpmake/core` to drive the
 * save-before-write logic in-process. This e2e tier instead spawns the built bin
 * against a LOOPBACK OpenAI-compatible mock (see helpers/mock-llm.ts), so the
 * real provider layer, SSRF guard, spec loader, and emitter all run — net-free,
 * no real key. The mock returns a canned OpenAPI document and we assert the
 * exact tool files that document produces land on disk.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { E2E } from './helpers/gating.js';
import { startMockLlm, mockLlmEnv, type MockLlm } from './helpers/mock-llm.js';

/**
 * Canned OpenAPI spec the mock returns for `describe`. Three operations whose
 * REST resource names are deterministic, so the emitted tool filenames are
 * known exactly: GET /widgets → list_widgets, POST /widgets → create_widget,
 * GET /widgets/{id} → get_widget. (`buildAllTools` uses the operationId; these
 * operationIds already read as those names.)
 */
const CANNED_SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Widget API', version: '2.0.0' },
  servers: [{ url: 'https://widgets.example.com/v1' }],
  paths: {
    '/widgets': {
      get: {
        operationId: 'listWidgets',
        summary: 'List widgets',
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: 'createWidget',
        summary: 'Create a widget',
        responses: { '201': { description: 'ok' } },
      },
    },
    '/widgets/{id}': {
      get: {
        operationId: 'getWidget',
        summary: 'Get widget',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});

/** The exact per-tool files the canned 3-operation spec must emit. */
const EXPECTED_TOOL_FILES = ['create-widget.ts', 'get-widget.ts', 'index.ts', 'list-widgets.ts'];

/** Sorted list of files in <out>/src/tools, for an exact on-disk assertion. */
function toolFiles(out: string): string[] {
  const dir = join(out, 'src', 'tools');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe.skipIf(!E2E)('e2e: from describe (mock LLM)', () => {
  let mock: MockLlm | undefined;

  beforeAll(() => ensureBuilt());

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = undefined;
    }
  });

  it('with no provider configured, exits 1 and says it requires an LLM provider', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      // No mockLlmEnv merged → the default `anthropic` provider with no key.
      const r = await runCli(['from', 'describe', 'manage widgets', '-o', out], { cwd: dir });

      expect(r.code).toBe(1);
      const text = combined(r);
      // Exact message from requireLlmProvider('describe mode') in core.
      expect(text).toContain('describe mode requires an LLM provider');
      expect(text).toContain('Set ANTHROPIC_API_KEY');
      // It bailed before generating anything.
      expect(existsSync(out)).toBe(false);
    });
  });

  it('with the mock provider, emits the exact tools from the canned spec (exit 0)', async () => {
    mock = await startMockLlm();
    mock.setChatContent(CANNED_SPEC);

    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(['from', 'describe', 'manage widgets', '-o', out], {
        cwd: dir,
        env: mockLlmEnv(mock!),
      });

      expect(r.code).toBe(0);
      const text = combined(r);
      // The canned spec has exactly 3 operations; the CLI reports them by name.
      expect(text).toContain('Generated 3 operations');
      expect(text).toContain('Tools generated: 3');
      expect(text).toContain('- list_widgets:');
      expect(text).toContain('- create_widget:');
      expect(text).toContain('- get_widget:');

      // The exact per-tool files the 3-operation spec produces, on disk.
      expect(toolFiles(out)).toEqual(EXPECTED_TOOL_FILES);

      // The mock actually served exactly one chat completion (spec generation).
      expect(mock!.chatRequests()).toHaveLength(1);
    });
  });

  it('--save-spec writes the spec file ONLY after a successful parse', async () => {
    mock = await startMockLlm();
    mock.setChatContent(CANNED_SPEC);

    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'describe', 'manage widgets', '-o', out, '--save-spec', 'spec.json'],
        { cwd: dir, env: mockLlmEnv(mock!) },
      );

      expect(r.code).toBe(0);
      expect(combined(r)).toContain('Saved generated spec to:');
      // The spec was persisted (relative to the cwd) only because it parsed.
      expect(existsSync(join(dir, 'spec.json'))).toBe(true);
    });
  });

  it('--save-spec does NOT write the file when the generated spec fails to parse', async () => {
    mock = await startMockLlm();
    // Valid JSON, but not a valid OpenAPI document — loadOpenApiSpec rejects it,
    // and the save must happen only AFTER that parse succeeds.
    mock.setChatContent(JSON.stringify({ not: 'an openapi spec', random: true }));

    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'describe', 'manage widgets', '-o', out, '--save-spec', 'spec.json'],
        { cwd: dir, env: mockLlmEnv(mock!) },
      );

      expect(r.code).toBe(1);
      // The parser rejected the canned non-OpenAPI document.
      expect(combined(r)).toContain('is not a valid Openapi API definition');
      // Nothing was persisted: save is gated on a successful parse.
      expect(existsSync(join(dir, 'spec.json'))).toBe(false);
    });
  });

  it('rejects a ../ traversal path for --save-spec before doing any work', async () => {
    mock = await startMockLlm();
    mock.setChatContent(CANNED_SPEC);

    await withTempDir(async (dir) => {
      const out = join(dir, 'out');
      const r = await runCli(
        ['from', 'describe', 'manage widgets', '-o', out, '--save-spec', '../escape.json'],
        { cwd: dir, env: mockLlmEnv(mock!) },
      );

      expect(r.code).toBe(1);
      // Exact message from resolveSaveSpecPath's traversal guard.
      expect(combined(r)).toContain('Refusing to write --save-spec outside the working directory');
      // The file outside the cwd must not exist.
      expect(existsSync(join(dir, '..', 'escape.json'))).toBe(false);
      // The traversal is rejected up-front, before the LLM is even called.
      expect(mock!.chatRequests()).toHaveLength(0);
    });
  });
});
