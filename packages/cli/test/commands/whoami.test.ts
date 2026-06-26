/**
 * `mcpmake whoami` channel-refusal labelling.
 *
 * Regression: whoami swallowed every failure from `apiRequest(...).catch(() => null)`
 * and reported it as `Stored token was rejected. Run \`mcpmake login\` again.` But
 * `assertSecureChannel` throws SYNCHRONOUSLY (before any network call) when the
 * stored serverUrl is a plaintext, non-loopback host without --insecure. That
 * channel-policy refusal was mislabelled as a token (auth) rejection, advising a
 * re-login that cannot fix it. The fix calls assertSecureChannel first (mirroring
 * login.ts) and surfaces the real message.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as apiClient from '../../src/auth/api-client.js';
import * as credentials from '../../src/auth/credentials.js';
import { logger } from '@mcpmake/core';

describe('whoami — plaintext-remote channel refusal is not mislabelled as a rejected token', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    spies.length = 0;
    delete process.env.MCPMAKE_INSECURE;
  });

  it('fails with the channel-policy message and never issues the request', async () => {
    // Stored credentials point at a plaintext, NON-loopback host — exactly the
    // case assertSecureChannel refuses without --insecure.
    spies.push(
      vi.spyOn(credentials, 'loadCredentials').mockResolvedValue({
        serverUrl: 'http://api.example.com',
        token: 'mfd_stored_secret',
      } as Awaited<ReturnType<typeof credentials.loadCredentials>>),
    );
    spies.push(vi.spyOn(credentials, 'resolveDeployToken').mockReturnValue('mfd_stored_secret'));

    const apiRequest = vi
      .spyOn(apiClient, 'apiRequest')
      .mockResolvedValue({ status: 200, body: { email: 'x@y.z', plan: 'free' } });
    spies.push(apiRequest);

    const errors: string[] = [];
    spies.push(
      vi.spyOn(logger, 'error').mockImplementation((...a: unknown[]) => {
        errors.push(a.map(String).join(' '));
      }),
    );
    spies.push(vi.spyOn(logger, 'info').mockImplementation(() => {}));
    // Repo convention: fail() calls process.exit; convert it to a throw so the
    // command's control flow stops here and we can assert on it.
    spies.push(
      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as never),
    );

    const whoamiCommand = (await import('../../src/commands/whoami.js')).default;

    let threw: unknown;
    try {
      // citty passes a parsed args object; only the fields whoami reads matter.
      await (whoamiCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({
        args: { insecure: false },
      });
    } catch (e) {
      threw = e;
    }

    expect((threw as Error).message).toBe('process.exit called');
    // The surfaced message is the channel-policy refusal — NOT the token rejection.
    const joined = errors.join('\n');
    expect(joined).toMatch(/unencrypted \(non-HTTPS\) channel/);
    expect(joined).not.toMatch(/Stored token was rejected/);
    // The token-bearing request was short-circuited before the network.
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('with --insecure the channel guard is a no-op and the request proceeds', async () => {
    spies.push(
      vi.spyOn(credentials, 'loadCredentials').mockResolvedValue({
        serverUrl: 'http://api.example.com',
        token: 'mfd_stored_secret',
      } as Awaited<ReturnType<typeof credentials.loadCredentials>>),
    );
    spies.push(vi.spyOn(credentials, 'resolveDeployToken').mockReturnValue('mfd_stored_secret'));
    const apiRequest = vi
      .spyOn(apiClient, 'apiRequest')
      .mockResolvedValue({ status: 200, body: { email: 'me@example.com', plan: 'team' } });
    spies.push(apiRequest);
    const infos: string[] = [];
    spies.push(
      vi.spyOn(logger, 'info').mockImplementation((...a: unknown[]) => {
        infos.push(a.map(String).join(' '));
      }),
    );

    const whoamiCommand = (await import('../../src/commands/whoami.js')).default;
    await (whoamiCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({
      args: { insecure: true },
    });

    // The guard returned (insecure opt-in), so the request happened and the
    // identity was printed — proving the new guard does not break the happy path.
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(infos.join('\n')).toMatch(/Logged in as me@example\.com/);
  });
});
