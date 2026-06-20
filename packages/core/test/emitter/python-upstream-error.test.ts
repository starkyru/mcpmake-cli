import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolDefinition } from '../../src/transformer/tool-builder.js';
import { emitPythonProject } from '../../src/emitter/index.js';
import type { OperationDescriptor, ProjectManifest } from '../../src/types/index.js';

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'listPets',
    method: 'get',
    path: '/pets',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

function manifest(): ProjectManifest {
  return {
    serverName: 'pet-api',
    serverVersion: '1.0.0',
    baseUrl: 'https://api.example.com',
    transport: 'stdio',
    tools: [buildToolDefinition(makeOp())],
    authSchemes: [],
    envVars: [{ name: 'BASE_URL', description: 'base', required: false }],
  };
}

function withTmp(fn: (dir: string) => Promise<void> | void): Promise<void> {
  return (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpmake-pyerr-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

describe('INFO-apierr — generated python server does not leak upstream error bodies', () => {
  it('checks the upstream status and returns a sanitized 4xx/5xx error', async () => {
    await withTmp(async (dir) => {
      await emitPythonProject(manifest(), { outputDir: dir, force: true, dryRun: false });
      const py = readFileSync(join(dir, 'server.py'), 'utf-8');

      // The error path is gated on the HTTP status code.
      expect(py).toContain('if resp.status_code >= 400:');
      // Only the status code + generic reason is surfaced — never the raw body.
      expect(py).toContain('upstream returned {resp.status_code} {resp.reason_phrase}');

      // The success branch (json.dumps of the parsed body) must be unreachable
      // for a 4xx/5xx: the only json.dumps must sit after the status guard.
      const guardIdx = py.indexOf('if resp.status_code >= 400:');
      const dumpsIdx = py.indexOf('json.dumps(data');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(dumpsIdx).toBeGreaterThan(guardIdx);

      // Regression: the raw upstream body must not be dumped before the guard.
      const beforeGuard = py.slice(0, guardIdx);
      expect(beforeGuard).not.toContain('json.dumps(data');
    });
  });
});
