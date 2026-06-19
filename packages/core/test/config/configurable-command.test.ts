import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, type ArgsDef } from 'citty';
import { defineConfigurableCommand } from '../../src/config/configurable-command.js';
import { logger } from '../../src/utils/logger.js';

const ARGS: ArgsDef = {
  output: { type: 'string', alias: 'o' },
  transport: { type: 'string', default: 'stdio' },
};

let dir: string;
let prevCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfg-cmd-'));
  prevCwd = process.cwd();
  process.chdir(dir); // config auto-discovery resolves against cwd
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

function makeCmd(capture: (args: Record<string, unknown>) => void) {
  return defineConfigurableCommand('openapi', {
    meta: { name: 'openapi' },
    args: ARGS,
    run({ args }) {
      capture({ ...args });
    },
  });
}

describe('defineConfigurableCommand', () => {
  it('overlays .mcpmake.yaml values onto args', async () => {
    writeFileSync(join(dir, '.mcpmake.yaml'), 'output: ./from-config\ntransport: http\n');
    let seen: Record<string, unknown> = {};
    await runCommand(
      makeCmd((a) => (seen = a)),
      { rawArgs: [] },
    );
    expect(seen.output).toBe('./from-config');
    expect(seen.transport).toBe('http');
  });

  it('lets an explicit CLI flag win over config', async () => {
    writeFileSync(join(dir, '.mcpmake.yaml'), 'transport: http\n');
    let seen: Record<string, unknown> = {};
    await runCommand(
      makeCmd((a) => (seen = a)),
      { rawArgs: ['--transport', 'stdio'] },
    );
    expect(seen.transport).toBe('stdio');
  });

  it('runs cleanly with no config file present', async () => {
    let seen: Record<string, unknown> = {};
    await runCommand(
      makeCmd((a) => (seen = a)),
      { rawArgs: ['--output', './cli'] },
    );
    expect(seen.output).toBe('./cli');
    expect(seen.transport).toBe('stdio'); // built-in default
  });

  it('accepts an explicit --config path', async () => {
    writeFileSync(join(dir, 'team.yaml'), 'output: ./team-out\n');
    let seen: Record<string, unknown> = {};
    await runCommand(
      makeCmd((a) => (seen = a)),
      { rawArgs: ['--config', 'team.yaml'] },
    );
    expect(seen.output).toBe('./team-out');
  });

  it('lets config satisfy a required flag (citty would otherwise reject it)', async () => {
    writeFileSync(join(dir, '.mcpmake.yaml'), 'output: ./from-config\n');
    let ran = false;
    const cmd = defineConfigurableCommand('openapi', {
      meta: { name: 'openapi' },
      args: { output: { type: 'string', alias: 'o', required: true } },
      run() {
        ran = true;
      },
    });
    await runCommand(cmd, { rawArgs: [] });
    expect(ran).toBe(true);
  });

  it('exits when a required flag is in neither CLI nor config', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const err = vi.spyOn(logger, 'error').mockImplementation(() => {});
    let ran = false;
    const cmd = defineConfigurableCommand('openapi', {
      meta: { name: 'openapi' },
      args: { output: { type: 'string', alias: 'o', required: true } },
      run() {
        ran = true;
      },
    });
    try {
      await runCommand(cmd, { rawArgs: [] });
    } catch {
      /* mocked process.exit throws to abort */
    }
    expect(exit).toHaveBeenCalledWith(1);
    expect(ran).toBe(false);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('Missing required argument: --output'),
    );
  });
});
