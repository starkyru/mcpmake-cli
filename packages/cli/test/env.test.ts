import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv } from '../src/env.js';

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
});
