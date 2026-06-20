import { describe, it, expect, afterEach } from 'vitest';
import { confirmPush } from '../../src/commands/publish.js';

describe('L-publishpush — publish --push requires confirmation', () => {
  const origStdin = process.stdin.isTTY;
  const origStdout = process.stdout.isTTY;
  const origCI = process.env.CI;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: origStdin, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: origStdout, configurable: true });
    if (origCI === undefined) delete process.env.CI;
    else process.env.CI = origCI;
  });

  it('refuses to push in a non-interactive run without --yes', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    delete process.env.CI;

    await expect(confirmPush('io.github.you/my-server', false)).resolves.toBe(false);
  });

  it('refuses to push in CI without --yes even on a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CI = 'true';

    await expect(confirmPush('io.github.you/my-server', false)).resolves.toBe(false);
  });

  it('proceeds when --yes is passed (explicit consent)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    delete process.env.CI;

    await expect(confirmPush('io.github.you/my-server', true)).resolves.toBe(true);
  });
});
