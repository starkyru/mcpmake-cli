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

  it('python .env.example escapes a CR/LF base URL value', async () => {
    await withTmp(async (dir) => {
      await emitPythonProject(
        manifest({
          baseUrl: 'https://api.example.com\nMCP_AUTH_TOKEN=attacker',
          environments: undefined,
          defaultEnvironment: undefined,
        }),
        { outputDir: dir, force: true, dryRun: false },
      );
      const env = readFileSync(join(dir, '.env.example'), 'utf-8');
      assertNoInjectedLine(env);
    });
  });
});
