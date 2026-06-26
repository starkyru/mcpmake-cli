import { defineCommand } from 'citty';
import { logger, fail } from '@mcpmake/core';
import { apiRequest, assertSecureChannel } from '../auth/api-client.js';
import { loadCredentials, resolveDeployToken } from '../auth/credentials.js';

const DEFAULT_SERVER = 'https://mcpmake.dev';

export default defineCommand({
  meta: {
    name: 'whoami',
    description: 'Show the account the CLI is authenticated as',
  },
  args: {
    server: {
      type: 'string',
      alias: 's',
      description: 'Backend URL (defaults to the one you logged in to)',
    },
    token: {
      type: 'string',
      alias: 't',
      description: 'Deploy token to check (defaults to the stored one)',
    },
    insecure: {
      type: 'boolean',
      description: 'Allow sending the deploy token to a non-HTTPS, non-localhost target',
      default: false,
    },
  },
  async run({ args }) {
    const stored = await loadCredentials();
    const serverUrl = String(args.server ?? stored?.serverUrl ?? DEFAULT_SERVER).replace(
      /\/+$/,
      '',
    );
    const token = resolveDeployToken({ explicit: args.token, serverUrl, stored });
    if (!token) {
      logger.info('Not logged in. Run:  mcpmake login');
      return;
    }
    // Refuse to send the token over a plaintext remote channel with a clear,
    // token-free message — mirroring login.ts. Without this, the blanket
    // `.catch(() => null)` below swallows assertSecureChannel's rejection and
    // mislabels a channel-policy refusal as a "token rejected" auth failure,
    // advising a re-login that cannot fix it.
    try {
      assertSecureChannel(new URL(serverUrl), args.insecure ?? false);
    } catch (e) {
      return await fail(e instanceof Error ? e.message : String(e));
    }
    const who = await apiRequest('GET', serverUrl, '/api/cli/whoami', {
      token,
      insecure: args.insecure ?? false,
    }).catch(() => null);
    if (!who || who.status !== 200) {
      return await fail('Stored token was rejected. Run `mcpmake login` again.');
    }
    logger.info(`Logged in as ${who.body.email} (plan: ${who.body.plan})`);
    logger.info(`Server:    ${serverUrl}`);
  },
});
