import { defineCommand } from 'citty';
import { logger, fail } from '@mcpmake/core';
import {
  apiRequest,
  openBrowser,
  sleep,
  assertSecureChannel,
  type ApiResponse,
} from '../auth/api-client.js';
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
    browser: {
      type: 'boolean',
      description: 'Open the browser automatically (use --no-browser to disable)',
      default: true,
    },
    insecure: {
      type: 'boolean',
      description: 'Allow sending the deploy token to a non-HTTPS, non-localhost target',
      default: false,
    },
  },
  async run({ args }) {
    const serverUrl = String(args.server).replace(/\/+$/, '');
    const insecure = args.insecure ?? false;

    // --- Paste fallback (CI / headless): verify the token, then store it. ------
    if (args.token) {
      if (!looksLikeDeployToken(args.token)) {
        return await fail('A deploy token must start with "mfd_". Mint one on the Account page.');
      }
      // Refuse to send the token over plaintext before we even contact the
      // server, with a clear (token-free) message rather than a generic reject.
      try {
        assertSecureChannel(new URL(serverUrl), insecure);
      } catch (e) {
        return await fail(e instanceof Error ? e.message : String(e));
      }
      const who = await apiRequest('GET', serverUrl, '/api/cli/whoami', {
        token: args.token,
        insecure,
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
    const rawInterval = Number(start.body.interval);
    const pollMs0 = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 5;
    let pollMs = Math.min(Math.max(2, pollMs0), 60) * 1000;
    const rawExpires = Number(start.body.expires_in);
    const expiresIn = Math.min(
      Number.isFinite(rawExpires) && rawExpires > 0 ? rawExpires : 600,
      3600,
    );
    const deadline = Date.now() + expiresIn * 1000;

    logger.info('');
    logger.info('To authorize this device, open:');
    logger.info('');
    logger.info(`    ${verificationUri}`);
    logger.info('');
    logger.info(`and enter the code:   ${userCode}`);
    logger.info('');
    // citty/mri parses the `--no-browser` token as negating the `browser`
    // boolean (args.browser === false); absent/default leaves it true. Treat
    // auto-open as enabled unless it was explicitly disabled.
    if (args.browser !== false) {
      // Only auto-open http(s) URLs. A malicious --server could return a
      // file:// or javascript: URI in verification_uri_complete; skip the
      // auto-open and let the user open the printed URL manually instead.
      let browserUrlOk = false;
      try {
        const { protocol } = new URL(verificationUriComplete);
        browserUrlOk = protocol === 'http:' || protocol === 'https:';
      } catch {
        // not a valid URL — skip auto-open
      }
      if (browserUrlOk) {
        logger.info('Opening your browser…');
        openBrowser(verificationUriComplete);
      } else {
        logger.info(
          'Could not auto-open browser (unexpected URL scheme). Open the link above manually.',
        );
      }
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
        pollMs = Math.min(pollMs + 5000, 60_000);
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

    const who = await apiRequest('GET', serverUrl, '/api/cli/whoami', { token, insecure }).catch(
      () => null,
    );
    const email = who && who.status === 200 ? (who.body.email as string) : undefined;
    await saveCredentials({ serverUrl, token, email });
    logger.success(`Logged in${email ? ` as ${email}` : ''}. Deploy with:  mcpmake deploy <spec>`);
  },
});
