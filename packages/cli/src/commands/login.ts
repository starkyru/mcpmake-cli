import { defineCommand } from 'citty';
import { logger, fail } from '@mcpmake/core';
import { apiRequest, openBrowser, sleep, type ApiResponse } from '../auth/api-client.js';
import { saveCredentials, looksLikeDeployToken } from '../auth/credentials.js';

const DEFAULT_SERVER = 'https://mcpmake.dev';

export default defineCommand({
  meta: {
    name: 'login',
    description: 'Authenticate the CLI with your mcpmake account (browser device flow)',
  },
  args: {
    server: {
      type: 'string',
      alias: 's',
      description: 'Backend URL',
      default: DEFAULT_SERVER,
    },
    token: {
      type: 'string',
      alias: 't',
      description: 'Paste a deploy token (mfd_…) instead of the browser flow (CI/headless)',
    },
    'no-browser': {
      type: 'boolean',
      description: "Don't try to open the browser automatically",
      default: false,
    },
  },
  async run({ args }) {
    const serverUrl = String(args.server).replace(/\/+$/, '');

    // --- Paste fallback (CI / headless): verify the token, then store it. ------
    if (args.token) {
      if (!looksLikeDeployToken(args.token)) {
        return await fail('A deploy token must start with "mfd_". Mint one on the Account page.');
      }
      const who = await apiRequest('GET', serverUrl, '/api/cli/whoami', {
        token: args.token,
      }).catch((e): ApiResponse => ({ status: 0, body: { error: String(e) } }));
      if (who.status !== 200) {
        return await fail('That deploy token was rejected by the server.');
      }
      await saveCredentials({ serverUrl, token: args.token, email: who.body.email as string });
      logger.success(`Logged in as ${who.body.email}.`);
      return;
    }

    // --- Device flow ----------------------------------------------------------
    const start = await apiRequest('POST', serverUrl, '/api/cli/device/start', {
      json: {},
    }).catch((e): ApiResponse => ({ status: 0, body: { error: String(e) } }));
    if (start.status !== 200 || typeof start.body.device_code !== 'string') {
      return await fail(
        `Could not start login against ${serverUrl} (server returned ${start.status}).`,
      );
    }
    const deviceCode = start.body.device_code as string;
    const userCode = start.body.user_code as string;
    const verificationUri = start.body.verification_uri as string;
    const verificationUriComplete =
      (start.body.verification_uri_complete as string) || verificationUri;
    let pollMs = Math.max(2, Number(start.body.interval) || 5) * 1000;
    const deadline = Date.now() + (Number(start.body.expires_in) || 600) * 1000;

    logger.info('');
    logger.info('To authorize this device, open:');
    logger.info('');
    logger.info(`    ${verificationUri}`);
    logger.info('');
    logger.info(`and enter the code:   ${userCode}`);
    logger.info('');
    if (!args['no-browser']) {
      logger.info('Opening your browser…');
      openBrowser(verificationUriComplete);
    }
    logger.info('Waiting for approval (Ctrl-C to cancel)…');

    let token: string | undefined;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const res = await apiRequest('POST', serverUrl, '/api/cli/device/token', {
        json: { device_code: deviceCode },
      }).catch(() => ({ status: 0, body: {} as Record<string, unknown> }));

      if (res.status === 200 && typeof res.body.access_token === 'string') {
        token = res.body.access_token as string;
        break;
      }
      const err = res.body.error;
      if (err === 'authorization_pending' || res.status === 0) continue;
      if (err === 'slow_down') {
        pollMs += 5000;
        continue;
      }
      if (err === 'access_denied') return await fail('Login was denied in the browser.');
      if (err === 'expired_token') {
        return await fail('The login code expired. Run `mcpmake login` again.');
      }
      // Unknown transient error — keep polling until the deadline.
    }

    if (!token) {
      return await fail('Login timed out before approval. Run `mcpmake login` again.');
    }

    const who = await apiRequest('GET', serverUrl, '/api/cli/whoami', { token }).catch(() => null);
    const email = who && who.status === 200 ? (who.body.email as string) : undefined;
    await saveCredentials({ serverUrl, token, email });
    logger.success(`Logged in${email ? ` as ${email}` : ''}. Deploy with:  mcpmake deploy <spec>`);
  },
});
