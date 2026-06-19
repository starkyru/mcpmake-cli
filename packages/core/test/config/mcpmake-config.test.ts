import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArgsDef } from 'citty';
import {
  findConfigPath,
  loadConfig,
  globalConfig,
  sectionConfig,
  explicitFlags,
  applyConfigToArgs,
} from '../../src/config/mcpmake-config.js';
import { logger } from '../../src/utils/logger.js';

// A representative subset of the `openapi` arg spec.
const OPENAPI_ARGS: ArgsDef = {
  spec: { type: 'positional' },
  output: { type: 'string', alias: 'o' },
  name: { type: 'string', alias: 'n' },
  'base-url': { type: 'string', alias: 'b' },
  transport: { type: 'string', alias: 't', default: 'stdio' },
  include: { type: 'string', alias: 'i' },
  force: { type: 'boolean', alias: 'f', default: false },
  'no-resources': { type: 'boolean', default: false },
};

let dir: string;

function writeConfig(name: string, body: string): void {
  writeFileSync(join(dir, name), body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpmake-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('findConfigPath', () => {
  it('auto-discovers .mcpmake.yaml in cwd', () => {
    writeConfig('.mcpmake.yaml', 'output: ./gen\n');
    expect(findConfigPath({ cwd: dir, env: {} })).toBe(join(dir, '.mcpmake.yaml'));
  });

  it('falls back to .mcpmake.yml', () => {
    writeConfig('.mcpmake.yml', 'output: ./gen\n');
    expect(findConfigPath({ cwd: dir, env: {} })).toBe(join(dir, '.mcpmake.yml'));
  });

  it('returns null when no config exists', () => {
    expect(findConfigPath({ cwd: dir, env: {} })).toBeNull();
  });

  it('honours MCPMAKE_CONFIG env', () => {
    writeConfig('custom.yaml', 'output: ./gen\n');
    expect(findConfigPath({ cwd: dir, env: { MCPMAKE_CONFIG: 'custom.yaml' } })).toBe(
      join(dir, 'custom.yaml'),
    );
  });

  it('prefers an explicit configPath over env and auto-discovery', () => {
    writeConfig('.mcpmake.yaml', 'output: ./auto\n');
    writeConfig('explicit.yaml', 'output: ./explicit\n');
    expect(findConfigPath({ cwd: dir, env: {}, configPath: 'explicit.yaml' })).toBe(
      join(dir, 'explicit.yaml'),
    );
  });

  it('throws when an explicit config path is missing', () => {
    expect(() => findConfigPath({ cwd: dir, env: {}, configPath: 'nope.yaml' })).toThrow(
      /not found/,
    );
  });
});

describe('loadConfig', () => {
  it('parses a YAML mapping', () => {
    writeConfig('.mcpmake.yaml', 'output: ./gen\ntransport: http\n');
    const loaded = loadConfig({ cwd: dir, env: {} });
    expect(loaded?.data).toEqual({ output: './gen', transport: 'http' });
  });

  it('returns null when there is no config', () => {
    expect(loadConfig({ cwd: dir, env: {} })).toBeNull();
  });

  it('treats an empty file as empty config', () => {
    writeConfig('.mcpmake.yaml', '');
    expect(loadConfig({ cwd: dir, env: {} })?.data).toEqual({});
  });

  it('throws on a non-mapping top level', () => {
    writeConfig('.mcpmake.yaml', '- just\n- a\n- list\n');
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/must be a YAML mapping/);
  });

  it('throws on malformed YAML', () => {
    writeConfig('.mcpmake.yaml', 'output: ./gen\n  bad: : :\n');
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/Failed to parse/);
  });
});

describe('globalConfig / sectionConfig', () => {
  const data = {
    output: './gen',
    transport: 'http',
    openapi: { 'base-url': 'https://api.example.com' },
    deploy: { server: 'https://mcpmake.dev' },
  };

  it('global excludes command sections', () => {
    expect(globalConfig(data)).toEqual({ output: './gen', transport: 'http' });
  });

  it('section returns the per-command block', () => {
    expect(sectionConfig(data, 'openapi')).toEqual({ 'base-url': 'https://api.example.com' });
  });

  it('section is empty for an absent command', () => {
    expect(sectionConfig(data, 'har')).toEqual({});
  });

  it('a scalar key named like a command stays global (not a section)', () => {
    // `verify: true` is a global scalar, not a section.
    expect(globalConfig({ verify: true })).toEqual({ verify: true });
    expect(sectionConfig({ verify: true }, 'verify')).toEqual({});
  });
});

describe('explicitFlags', () => {
  it('detects long flags, =form, and short aliases', () => {
    const set = explicitFlags(['--output', 'x', '--name=srv', '-f'], OPENAPI_ARGS);
    expect(set.has('output')).toBe(true);
    expect(set.has('name')).toBe(true);
    expect(set.has('force')).toBe(true);
  });

  it('maps citty negation --no-force to force', () => {
    expect(explicitFlags(['--no-force'], OPENAPI_ARGS).has('force')).toBe(true);
  });

  it('keeps a real no-* arg literal (no-resources), not stripped to resources', () => {
    const set = explicitFlags(['--no-resources'], OPENAPI_ARGS);
    expect(set.has('no-resources')).toBe(true);
    expect(set.has('resources')).toBe(false);
  });

  it('stops at the -- terminator', () => {
    expect(explicitFlags(['--', '--output', 'x'], OPENAPI_ARGS).has('output')).toBe(false);
  });

  it('resolves bundled short flags', () => {
    expect(explicitFlags(['-ft'], OPENAPI_ARGS)).toEqual(new Set(['force', 'transport']));
  });
});

describe('applyConfigToArgs', () => {
  it('fills unset args from global + section (section wins)', () => {
    writeConfig(
      '.mcpmake.yaml',
      ['output: ./gen', 'transport: http', 'openapi:', '  base-url: https://api.example.com'].join(
        '\n',
      ),
    );
    const args: Record<string, unknown> = { transport: 'stdio' }; // citty default
    const result = applyConfigToArgs(args, [], 'openapi', OPENAPI_ARGS, { cwd: dir, env: {} });

    expect(args.output).toBe('./gen');
    expect(args.transport).toBe('http');
    expect(args['base-url']).toBe('https://api.example.com');
    expect(result.applied.sort()).toEqual(['base-url', 'output', 'transport']);
  });

  it('per-command section overrides a global of the same key', () => {
    writeConfig(
      '.mcpmake.yaml',
      ['name: global-name', 'openapi:', '  name: openapi-name'].join('\n'),
    );
    const aArgs: Record<string, unknown> = {};
    applyConfigToArgs(aArgs, [], 'openapi', OPENAPI_ARGS, { cwd: dir, env: {} });
    expect(aArgs.name).toBe('openapi-name');

    const bArgs: Record<string, unknown> = {};
    applyConfigToArgs(bArgs, [], 'har', { name: { type: 'string' } }, { cwd: dir, env: {} });
    expect(bArgs.name).toBe('global-name');
  });

  it('never overrides an explicit CLI flag', () => {
    writeConfig('.mcpmake.yaml', 'transport: http\n');
    const args: Record<string, unknown> = { transport: 'stdio' };
    applyConfigToArgs(args, ['--transport', 'stdio'], 'openapi', OPENAPI_ARGS, {
      cwd: dir,
      env: {},
    });
    expect(args.transport).toBe('stdio'); // flag wins over config
  });

  it('coerces array values to the comma-separated flag form', () => {
    writeConfig(
      '.mcpmake.yaml',
      ['openapi:', '  include:', '    - users', '    - repos'].join('\n'),
    );
    const args: Record<string, unknown> = {};
    applyConfigToArgs(args, [], 'openapi', OPENAPI_ARGS, { cwd: dir, env: {} });
    expect(args.include).toBe('users,repos');
  });

  it('coerces booleans (string and native)', () => {
    writeConfig('.mcpmake.yaml', 'force: "true"\n');
    const args: Record<string, unknown> = { force: false };
    applyConfigToArgs(args, [], 'openapi', OPENAPI_ARGS, { cwd: dir, env: {} });
    expect(args.force).toBe(true);
  });

  it('never fills a positional from config', () => {
    writeConfig('.mcpmake.yaml', 'spec: should-be-ignored\n');
    const args: Record<string, unknown> = {};
    const result = applyConfigToArgs(args, [], 'openapi', OPENAPI_ARGS, { cwd: dir, env: {} });
    expect(args.spec).toBeUndefined();
    expect(result.applied).not.toContain('spec');
  });

  it('warns on an unknown key in a command section', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    writeConfig('.mcpmake.yaml', ['openapi:', '  outpt: ./typo'].join('\n'));
    const args: Record<string, unknown> = {};
    applyConfigToArgs(args, [], 'openapi', OPENAPI_ARGS, { cwd: dir, env: {} });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openapi.outpt'));
    expect(args.outpt).toBeUndefined();
  });

  it('silently skips a global key not used by this command', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // `server` is a deploy arg, irrelevant to openapi — no warning, no apply.
    writeConfig('.mcpmake.yaml', 'server: https://mcpmake.dev\n');
    const args: Record<string, unknown> = {};
    const result = applyConfigToArgs(args, [], 'openapi', OPENAPI_ARGS, { cwd: dir, env: {} });
    expect(warn).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
  });

  it('returns a null path when no config is present', () => {
    const result = applyConfigToArgs({}, [], 'openapi', OPENAPI_ARGS, { cwd: dir, env: {} });
    expect(result).toEqual({ path: null, applied: [] });
  });
});
