/**
 * Tests for the level-gated `logger`.
 *
 * The true output boundary is the stream consola writes to:
 *   - info / success / log -> process.stdout
 *   - warn / error         -> process.stderr
 *
 * We capture both streams and assert whether a unique marker string for each
 * call actually reached the sink. Suppressed (below-threshold) calls must NOT
 * appear; at-or-above-threshold calls must appear. Markers are unique per call
 * so a stray emission from another method can't mask a suppression.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logger, LOG_LEVELS } from '../../src/utils/logger.js';

let captured: string;
let restoreOut: () => void;
let restoreErr: () => void;

function captureStreams(): void {
  captured = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  restoreOut = () => {
    process.stdout.write = origOut;
  };
  restoreErr = () => {
    process.stderr.write = origErr;
  };
}

function emitted(marker: string): boolean {
  return captured.includes(marker);
}

describe('logger level gating', () => {
  beforeEach(() => {
    captureStreams();
  });

  afterEach(() => {
    restoreOut();
    restoreErr();
    // Restore the default level so tests do not bleed into each other.
    logger.setLevel('info');
  });

  it('exposes an ordered severity scale: debug < info = success = log < warn < error', () => {
    expect(LOG_LEVELS.debug).toBeLessThan(LOG_LEVELS.info);
    expect(LOG_LEVELS.info).toBe(LOG_LEVELS.success);
    expect(LOG_LEVELS.success).toBe(LOG_LEVELS.log);
    expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.warn);
    expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.error);
  });

  it('default level (info) emits info/warn/error/success and suppresses debug', () => {
    logger.setLevel('info');
    expect(logger.level).toBe(LOG_LEVELS.info);

    logger.debug('GATED-debug-default');
    logger.info('GATED-info-default');
    logger.success('GATED-success-default');
    logger.warn('GATED-warn-default');
    logger.error('GATED-error-default');

    // debug is below the info threshold -> suppressed
    expect(emitted('GATED-debug-default')).toBe(false);
    // everything at/above info -> emitted
    expect(emitted('GATED-info-default')).toBe(true);
    expect(emitted('GATED-success-default')).toBe(true);
    expect(emitted('GATED-warn-default')).toBe(true);
    expect(emitted('GATED-error-default')).toBe(true);
  });

  it('setLevel("debug") makes debug emit', () => {
    logger.setLevel('debug');
    logger.debug('GATED-debug-shown');
    expect(emitted('GATED-debug-shown')).toBe(true);
  });

  it('setLevel("warn") suppresses info/success but still emits warn/error', () => {
    logger.setLevel('warn');
    expect(logger.level).toBe(LOG_LEVELS.warn);

    logger.debug('GATED-debug-warnlevel');
    logger.info('GATED-info-warnlevel');
    logger.success('GATED-success-warnlevel');
    logger.warn('GATED-warn-warnlevel');
    logger.error('GATED-error-warnlevel');

    expect(emitted('GATED-debug-warnlevel')).toBe(false);
    expect(emitted('GATED-info-warnlevel')).toBe(false);
    expect(emitted('GATED-success-warnlevel')).toBe(false);
    expect(emitted('GATED-warn-warnlevel')).toBe(true);
    expect(emitted('GATED-error-warnlevel')).toBe(true);
  });

  it('setLevel("error") suppresses warn and below; only error emits', () => {
    logger.setLevel('error');

    logger.warn('GATED-warn-errorlevel');
    logger.error('GATED-error-errorlevel');

    expect(emitted('GATED-warn-errorlevel')).toBe(false);
    expect(emitted('GATED-error-errorlevel')).toBe(true);
  });

  it('ignores an unknown level name and keeps the current threshold', () => {
    logger.setLevel('warn');
    const before = logger.level;
    const result = logger.setLevel('not-a-real-level');
    expect(result).toBe(before);
    expect(logger.level).toBe(LOG_LEVELS.warn);
  });
});
