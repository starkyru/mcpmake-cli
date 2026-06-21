import { defineCommand } from 'citty';
import { logger } from '@mcpmake/core';
import { apiRequest } from '../auth/api-client.js';
import { loadCredentials, clearCredentials } from '../auth/credentials.js';

export default defineCommand({
  meta: {
    name: 'logout',
    description: 'Sign out the CLI and revoke its deploy token',
  },
  async run() {
    const creds = await loadCredentials();
    if (!creds) {
      logger.info('Not logged in.');
      return;
    }
    // Best-effort server-side revoke so a stolen credentials file is useless.
    // The stored serverUrl was channel-validated when it was saved, but the
    // shared client still refuses plaintext-remote revoke without an opt-in
    // (MCPMAKE_INSECURE=1) — a refusal here just leaves the local clear below.
    const res = await apiRequest('POST', creds.serverUrl, '/api/cli/logout', {
      token: creds.token,
      insecure: process.env.MCPMAKE_INSECURE === '1',
    }).catch(() => null);
    await clearCredentials();
    if (res && res.status === 200) {
      logger.success('Logged out — the deploy token was revoked.');
    } else {
      logger.success(
        'Logged out locally. Could not reach the server to revoke the token; ' +
          'revoke it on the Account page if this device is untrusted.',
      );
    }
  },
});
