import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The describe command writes the --save-spec file only AFTER the generated
// spec parses. We mock core so generation returns invalid JSON and
// loadOpenApiSpec rejects, then assert nothing was persisted.
vi.mock('@mcpmake/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcpmake/core')>();
  return {
    ...actual,
    generateSpecFromDescription: vi.fn(async () => '{ not valid openapi'),
    loadOpenApiSpec: vi.fn(async () => {
      throw new Error('invalid spec');
    }),
  };
});

describe('describe --save-spec validate-before-write', () => {
  let cwd: string;
  let prevCwd: string;
  let describeCommand: { run?: (ctx: { args: Record<string, unknown> }) => Promise<unknown> };

  beforeEach(async () => {
    prevCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'mcpmake-describe-test-'));
    process.chdir(cwd);
    describeCommand = (await import('../../../src/commands/from/describe.js'))
      .default as typeof describeCommand;
  });

  it('does not write the spec file when the generated spec is invalid', async () => {
    const savePath = 'out-spec.json';
    await expect(
      describeCommand.run!({
        args: {
          description: 'manage things',
          output: join(cwd, 'gen'),
          'save-spec': savePath,
          force: false,
          'dry-run': true,
          transport: 'stdio',
        },
      }),
    ).rejects.toThrow();

    expect(existsSync(join(cwd, savePath))).toBe(false);
    process.chdir(prevCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects a --save-spec path that escapes the working directory', async () => {
    await expect(
      describeCommand.run!({
        args: {
          description: 'manage things',
          output: join(cwd, 'gen'),
          'save-spec': '../escape.json',
          force: false,
          'dry-run': true,
          transport: 'stdio',
        },
      }),
    ).rejects.toThrow(/outside the working directory/);

    expect(existsSync(join(cwd, '..', 'escape.json'))).toBe(false);
    process.chdir(prevCwd);
    rmSync(cwd, { recursive: true, force: true });
  });
});
