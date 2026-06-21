import { defineCommand } from 'citty';
import { logger, fail } from '@mcpmake/core';
import { apiRequest } from '../auth/api-client.js';
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
