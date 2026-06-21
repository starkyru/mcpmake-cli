import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv, isDeniedEnvKey, childEnv } from '../src/env.js';

describe('loadDotEnv', () => {
  // Unique, namespaced keys so we never clobber real environment variables.
  const KEYS = [
    'MCPMAKE_TEST_SIMPLE',
    'MCPMAKE_TEST_EXISTING',
    'MCPMAKE_TEST_QUOTED_DOUBLE',
    'MCPMAKE_TEST_QUOTED_SINGLE',
    'MCPMAKE_TEST_COMMENT',
    'MCPMAKE_TEST_EXPORT',
    'MCPMAKE_TEST_MISSING',
    'MCPMAKE_TEST_CRLF_QUOTED',
    'MCPMAKE_TEST_CRLF_UNQUOTED',
    'MCPMAKE_TEST_EMPTY_EXISTING',
    'MCPMAKE_TEST_EQ_VALUE',
    'MCPMAKE_TEST_UNBALANCED',
    // Denylist / regression-guard keys exercised below.
    'NODE_OPTIONS',
    'MCPMAKE_CONFIG_DIR',
    'OPENAI_BASE_URL',
    'MCPMAKE_SERVER',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'MCPMAKE_TEST_CUSTOM_TOKEN',
    'NODE_CUSTOM_THING',
  ] as const;

  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  function tmpEnvDir(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcpmake-env-'));
    writeFileSync(join(dir, '.env'), contents, 'utf8');
    return dir;
  }

  it('loads a simple KEY=value into process.env when previously unset', () => {
    const dir = tmpEnvDir('MCPMAKE_TEST_SIMPLE=hello\n');
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_SIMPLE).toBe('hello');
  });

  it('does not override a var already present in process.env', () => {
    process.env.MCPMAKE_TEST_EXISTING = 'from-shell';
    const dir = tmpEnvDir('MCPMAKE_TEST_EXISTING=from-file\n');
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_EXISTING).toBe('from-shell');
  });

  it('strips surrounding double and single quotes', () => {
    const dir = tmpEnvDir(
      'MCPMAKE_TEST_QUOTED_DOUBLE="double value"\n' + "MCPMAKE_TEST_QUOTED_SINGLE='single value'\n",
    );
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_QUOTED_DOUBLE).toBe('double value');
    expect(process.env.MCPMAKE_TEST_QUOTED_SINGLE).toBe('single value');
  });

  it('ignores # comment lines and blank lines', () => {
    const dir = tmpEnvDir('# this is a comment\n' + '\n' + '   \n' + 'MCPMAKE_TEST_COMMENT=kept\n');
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_COMMENT).toBe('kept');
  });

  it('handles an optional export prefix', () => {
    const dir = tmpEnvDir('export MCPMAKE_TEST_EXPORT=exported\n');
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_EXPORT).toBe('exported');
  });

  it('is a silent no-op when no .env file is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpmake-env-empty-'));
    expect(() => loadDotEnv(dir)).not.toThrow();
    expect(process.env.MCPMAKE_TEST_MISSING).toBeUndefined();
  });

  it('strips the trailing \\r from quoted and unquoted CRLF lines', () => {
    const dir = tmpEnvDir(
      'MCPMAKE_TEST_CRLF_QUOTED="value"\r\n' + 'MCPMAKE_TEST_CRLF_UNQUOTED=value\r\n',
    );
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_CRLF_QUOTED).toBe('value');
    expect(process.env.MCPMAKE_TEST_CRLF_UNQUOTED).toBe('value');
  });

  it('does not override a var already present as an empty string (real env wins)', () => {
    process.env.MCPMAKE_TEST_EMPTY_EXISTING = '';
    const dir = tmpEnvDir('MCPMAKE_TEST_EMPTY_EXISTING=from-file\n');
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_EMPTY_EXISTING).toBe('');
  });

  it('splits only on the first = so values may contain = characters', () => {
    const dir = tmpEnvDir('MCPMAKE_TEST_EQ_VALUE=a=b=c\n');
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_EQ_VALUE).toBe('a=b=c');
  });

  it('keeps the literal opening quote when quotes are unbalanced', () => {
    const dir = tmpEnvDir('MCPMAKE_TEST_UNBALANCED="value\n');
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_UNBALANCED).toBe('"value');
  });

  it('never loads process-control / credential keys from the file', () => {
    const dir = tmpEnvDir(
      'NODE_OPTIONS=--require=/evil.js\n' +
        'MCPMAKE_CONFIG_DIR=/tmp/attacker\n' +
        'OPENAI_BASE_URL=https://evil.example/v1\n' +
        'MCPMAKE_SERVER=https://evil.example\n',
    );
    loadDotEnv(dir);
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.MCPMAKE_CONFIG_DIR).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.MCPMAKE_SERVER).toBeUndefined();
  });

  it('blocks unknown keys by pattern (_TOKEN suffix and NODE_ prefix)', () => {
    const dir = tmpEnvDir('MCPMAKE_TEST_CUSTOM_TOKEN=secret\n' + 'NODE_CUSTOM_THING=danger\n');
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_CUSTOM_TOKEN).toBeUndefined();
    expect(process.env.NODE_CUSTOM_THING).toBeUndefined();
  });

  it('still loads legitimate LLM API keys (no over-blocking)', () => {
    const dir = tmpEnvDir('ANTHROPIC_API_KEY=sk-ant-test\n' + 'OPENAI_API_KEY=sk-openai-test\n');
    loadDotEnv(dir);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    expect(process.env.OPENAI_API_KEY).toBe('sk-openai-test');
  });

  it('lets an exported shell value win even over a denylisted-looking name', () => {
    // A non-denied key that already exists in the shell must keep its value.
    process.env.MCPMAKE_TEST_EXISTING = 'from-shell';
    const dir = tmpEnvDir('MCPMAKE_TEST_EXISTING=from-file\n');
    loadDotEnv(dir);
    expect(process.env.MCPMAKE_TEST_EXISTING).toBe('from-shell');
  });
});

describe('isDeniedEnvKey', () => {
  it('blocks exact dangerous keys, case-insensitively', () => {
    expect(isDeniedEnvKey('NODE_OPTIONS')).toBe(true);
    expect(isDeniedEnvKey('node_options')).toBe(true);
    expect(isDeniedEnvKey('MCPMAKE_CONFIG_DIR')).toBe(true);
    expect(isDeniedEnvKey('PATH')).toBe(true);
    expect(isDeniedEnvKey('LD_PRELOAD')).toBe(true);
  });

  it('blocks pattern variants', () => {
    expect(isDeniedEnvKey('NODE_SOMETHING')).toBe(true);
    expect(isDeniedEnvKey('DYLD_INSERT_LIBRARIES')).toBe(true);
    expect(isDeniedEnvKey('LD_AUDIT')).toBe(true);
    expect(isDeniedEnvKey('SOME_TOKEN')).toBe(true);
    expect(isDeniedEnvKey('CUSTOM_BASE_URL')).toBe(true);
    expect(isDeniedEnvKey('MY_CONFIG_DIR')).toBe(true);
  });

  it('allows ordinary keys, including LLM API keys', () => {
    expect(isDeniedEnvKey('ANTHROPIC_API_KEY')).toBe(false);
    expect(isDeniedEnvKey('OPENAI_API_KEY')).toBe(false);
    expect(isDeniedEnvKey('FOO')).toBe(false);
    expect(isDeniedEnvKey('MCPMAKE_TEST_SIMPLE')).toBe(false);
  });
});

describe('childEnv', () => {
  it('strips NODE_OPTIONS but keeps ordinary vars', () => {
    const base = {
      NODE_OPTIONS: '--require=/evil.js',
      PATH: '/usr/bin',
      FOO: 'bar',
    } as NodeJS.ProcessEnv;
    const out = childEnv(base);
    expect(out.NODE_OPTIONS).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.FOO).toBe('bar');
  });

  it('strips loader-injection vars (LD_*/DYLD_*) and NODE_PATH', () => {
    const base = {
      LD_PRELOAD: '/evil.so',
      DYLD_INSERT_LIBRARIES: '/evil.dylib',
      NODE_PATH: '/attacker/node_modules',
      KEEP: 'me',
    } as NodeJS.ProcessEnv;
    const out = childEnv(base);
    expect(out.LD_PRELOAD).toBeUndefined();
    expect(out.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(out.NODE_PATH).toBeUndefined();
    expect(out.KEEP).toBe('me');
  });

  it('does not mutate the base env (returns a copy)', () => {
    const base = { NODE_OPTIONS: '--require=/evil.js', FOO: 'bar' } as NodeJS.ProcessEnv;
    childEnv(base);
    expect(base.NODE_OPTIONS).toBe('--require=/evil.js');
  });
});
