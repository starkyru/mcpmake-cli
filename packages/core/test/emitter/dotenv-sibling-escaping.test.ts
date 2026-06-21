import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolDefinition } from '../../src/transformer/tool-builder.js';
import { emitWorkerProject, emitPythonProject } from '../../src/emitter/index.js';
import type { OperationDescriptor, ProjectManifest } from '../../src/types/index.js';

function makeOp(): OperationDescriptor {
  return {
    operationId: 'listPets',
    method: 'get',
    path: '/pets',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
  };
}

// A value carrying a CR/LF plus an attacker-controlled KEY=value line. Pre-fix,
// Handlebars (noEscape:true) would interpolate this raw and inject a second
// dotenv line into the operator's env file.
const INJECTION = 'production\nMCP_AUTH_TOKEN=attacker';

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    serverName: 'pet-api',
    serverVersion: '1.0.0',
    baseUrl: 'https://api.example.com',
    transport: 'http',
    tools: [buildToolDefinition(makeOp())],
    authSchemes: [],
    envVars: [{ name: 'BASE_URL', description: 'base', required: false }],
    environments: { production: 'https://api.example.com' },
    defaultEnvironment: INJECTION,
    ...over,
  };
}

/** No line in the file is the injected `MCP_AUTH_TOKEN=attacker` assignment. */
function assertNoInjectedLine(content: string): void {
  const injected = content.split('\n').some((line) => line.trim() === 'MCP_AUTH_TOKEN=attacker');
  expect(injected, 'CR/LF in a value injected an extra dotenv line').toBe(false);
}

/**
 * Return the single rendered dotenv line for `KEY` (everything after `KEY=`,
 * with surrounding whitespace trimmed). Asserts exactly one such line exists so
 * a value that broke onto a second physical line is caught rather than masked.
 */
function dotenvLine(content: string, key: string): string {
  const matches = content.split('\n').filter((line) => line.startsWith(`${key}=`));
  expect(matches, `expected exactly one ${key}= line`).toHaveLength(1);
  return matches[0].slice(`${key}=`.length);
}

describe('D-M3 — sibling dotenv files escape values', () => {
  function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
    return (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcpmake-dotenv-'));
      try {
        await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
  }

  it('worker .dev.vars.example quotes a CR/LF value so no extra line is injected', async () => {
    await withTmp(async (dir) => {
      await emitWorkerProject(manifest({ target: 'cloudflare' }), {
        outputDir: dir,
        force: true,
        dryRun: false,
      });
      const devVars = readFileSync(join(dir, '.dev.vars.example'), 'utf-8');
      assertNoInjectedLine(devVars);
      // The value is collapsed to a single line and quoted.
      expect(devVars).toContain('API_ENVIRONMENT="production MCP_AUTH_TOKEN=attacker"');
    });
  });

  it('python .env.example quotes a CR/LF value so no extra line is injected', async () => {
    await withTmp(async (dir) => {
      await emitPythonProject(manifest(), { outputDir: dir, force: true, dryRun: false });
      const env = readFileSync(join(dir, '.env.example'), 'utf-8');
      assertNoInjectedLine(env);
      expect(env).toContain('API_ENVIRONMENT="production MCP_AUTH_TOKEN=attacker"');
    });
  });

  // baseUrl is run through sanitizeUrlLiteral() BEFORE escapeDotenvValue(), so a
  // CR/LF in it never reaches the dotenv CR/LF *collapse* path — sanitizeUrlLiteral
  // has already turned the real CR/LF into the two-char literal sequences `\r` /
  // `\n`. This test pins THAT layer: it asserts the exact rendered BASE_URL line,
  // so the no-injection property is credited to sanitizeUrlLiteral (the layer that
  // actually neutralizes it here) and the test fails if its CR/LF handling
  // regresses (dropping the `\n`→`\\n` replacement would leave a real newline and
  // a second physical line, breaking dotenvLine's single-line assertion).
  it('python .env.example BASE_URL pins sanitizeUrlLiteral CR/LF neutralization', async () => {
    await withTmp(async (dir) => {
      await emitPythonProject(
        manifest({
          baseUrl: 'https://api.example.com\r\nMCP_AUTH_TOKEN=attacker',
          environments: undefined,
          defaultEnvironment: undefined,
        }),
        { outputDir: dir, force: true, dryRun: false },
      );
      const env = readFileSync(join(dir, '.env.example'), 'utf-8');
      assertNoInjectedLine(env);
      // sanitizeUrlLiteral: real CR/LF -> two-char literals `\r` and `\n` (one
      // backslash each). escapeDotenvValue then sees backslashes, so it quotes the
      // value and doubles each backslash -> `\\r\\n`. The exact rendered value is
      // the double-quoted literal below; a regression in either CR or LF handling
      // (e.g. only one of \r/\n replaced) would not match this byte-for-byte.
      expect(dotenvLine(env, 'BASE_URL')).toBe(
        '"https://api.example.com\\\\r\\\\nMCP_AUTH_TOKEN=attacker"',
      );
    });
  });

  // Companion that exercises the OTHER layer: the escapeDotenvValue CR/LF *collapse*
  // path. defaultEnvironment is NOT url-literal-sanitized, so a real CR/LF reaches
  // escapeDotenvValue directly and must be collapsed to a single space (exactly the
  // defense tests 1-2 advertise). Exact content check, not a substring/no-line probe.
  it('python .env.example API_ENVIRONMENT collapses a CR/LF defaultEnvironment via escapeDotenvValue', async () => {
    await withTmp(async (dir) => {
      await emitPythonProject(
        manifest({ defaultEnvironment: 'production\r\nMCP_AUTH_TOKEN=attacker' }),
        { outputDir: dir, force: true, dryRun: false },
      );
      const env = readFileSync(join(dir, '.env.example'), 'utf-8');
      assertNoInjectedLine(env);
      // CR/LF collapsed to a single space, then quoted because it now contains
      // whitespace that would otherwise let dotenv split the token.
      expect(dotenvLine(env, 'API_ENVIRONMENT')).toBe('"production MCP_AUTH_TOKEN=attacker"');
      // Positive companion: a benign defaultEnvironment IS emitted unquoted and
      // intact, so the quoting above is attributable to the CR/LF, not blanket
      // quoting (a regression that always quoted would still pass the line above).
    });
  });

  it('python .env.example emits a benign API_ENVIRONMENT unquoted and intact', async () => {
    await withTmp(async (dir) => {
      await emitPythonProject(manifest({ defaultEnvironment: 'production' }), {
        outputDir: dir,
        force: true,
        dryRun: false,
      });
      const env = readFileSync(join(dir, '.env.example'), 'utf-8');
      expect(dotenvLine(env, 'API_ENVIRONMENT')).toBe('production');
    });
  });
});
