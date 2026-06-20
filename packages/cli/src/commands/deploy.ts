import { defineConfigurableCommand } from '@mcpmake/core';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { loadCredentials, resolveDeployToken } from '../auth/credentials.js';

const MAX_SPEC_SIZE = 5 * 1024 * 1024; // 5 MB

export default defineConfigurableCommand('deploy', {
  meta: {
    name: 'deploy',
    description: 'Deploy an MCP server to the hosting backend',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Path to OpenAPI spec or HAR file',
      required: true,
    },
    name: {
      type: 'string',
      alias: 'n',
      description: 'Server name (default: derived from spec)',
    },
    server: {
      type: 'string',
      alias: 's',
      description: 'Cloud server URL (defaults to the one you logged in to)',
    },
    token: {
      type: 'string',
      alias: 't',
      description: 'Deploy token (mfd_…). Usually unnecessary — run `mcpmake login` first',
    },
    insecure: {
      type: 'boolean',
      description: 'Allow sending the deploy token to a non-HTTPS, non-localhost target',
      default: false,
    },
    'show-token': {
      type: 'boolean',
      description: 'Print the issued bearer token in full (default: redacted)',
      default: false,
    },
  },
  async run({ args }) {
    const specPath = resolve(args.spec);

    // Validate file exists and size
    let fileInfo;
    try {
      fileInfo = await stat(specPath);
    } catch (err) {
      return await fail(`File not found: ${specPath}`, err);
    }

    if (fileInfo.size > MAX_SPEC_SIZE) {
      return await fail(
        `Spec file too large (${Math.round(fileInfo.size / 1024)}KB). Maximum is 5MB.`,
      );
    }

    const ext = extname(specPath).toLowerCase();
    const allowedExtensions = new Set(['.yaml', '.yml', '.json', '.har']);
    if (!allowedExtensions.has(ext)) {
      await fail('Invalid file type. Accepted: .yaml, .yml, .json, .har');
    }

    // Resolve the target + credential: an explicit --server wins, else the
    // backend the user logged in to, else the local dev default.
    const stored = await loadCredentials();
    const serverUrl = (args.server ?? stored?.serverUrl ?? 'http://localhost:3001').replace(
      /\/+$/,
      '',
    );
    logger.info(`Deploying spec: ${specPath}`);
    logger.info(`Target: ${serverUrl}`);

    // Read the spec file
    const specData = await readFile(specPath);
    const fileName = basename(specPath);

    // Build multipart form data
    const boundary = `----mcpmake${Date.now()}${Math.random().toString(36).slice(2)}`;
    const parts: Buffer[] = [];

    // Add name field if provided
    if (args.name) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${args.name}\r\n`,
        ),
      );
    }

    // Add spec file
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="spec"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(specData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    // Per-user deploy token from `mcpmake login` (or --token / MCPMAKE_DEPLOY_TOKEN
    // for CI). No admin token is ever used here.
    const token = resolveDeployToken({ explicit: args.token, serverUrl, stored });

    // A remote backend requires a deploy token (the tokenless path is loopback-
    // only on the server). Fail early with a helpful message instead of a 403.
    if (!token) {
      let remote = false;
      try {
        remote = !isLoopbackHost(new URL(serverUrl).hostname);
      } catch {
        remote = false;
      }
      if (remote) {
        return await fail(
          'Not logged in. Run `mcpmake login` first ' +
            '(or pass --token mfd_… / set MCPMAKE_DEPLOY_TOKEN for CI).',
        );
      }
    }

    // Guard the credential channel: refuse to send the deploy token over an
    // unencrypted, non-loopback link unless the user explicitly opts in.
    if (token) {
      const insecureChannel = await assertTokenChannel(serverUrl, args.insecure ?? false);
      if (insecureChannel) {
        console.warn(
          `WARNING: Sending the deploy token to ${serverUrl} over an unencrypted channel. ` +
            'The credential is exposed in transit; use HTTPS in production.',
        );
      }
    }

    // POST to the hosting backend
    logger.info('Uploading spec...');

    try {
      const result = await postMultipart(serverUrl, '/api/servers', boundary, body, token);

      logger.success('Server deployed!');
      logger.info('');
      logger.info(`  Slug:     ${result.slug}`);
      logger.info(`  Endpoint: ${result.endpoint}`);
      logger.info(
        `  Token:    ${formatIssuedToken(result.bearerToken, args['show-token'] ?? false)}`,
      );
      logger.info(`  Tools:    ${result.toolCount}`);
      logger.info('');
      logger.info('Claude Desktop config (add to claude_desktop_config.json):');
      logger.info('');
      const showToken = args['show-token'] ?? false;
      logger.info(formatClaudeConfig(result.claudeDesktopConfig, result.bearerToken, showToken));
      if (!showToken) {
        logger.info('');
        logger.info('Token redacted. Re-run with --show-token to reveal it.');
      }
      logger.info('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await fail(`Deploy failed: ${message}`, err);
    }
  },
});

interface DeployResult {
  slug: string;
  endpoint: string;
  bearerToken: string;
  status: string;
  toolCount: number;
  claudeDesktopConfig: Record<string, unknown>;
}

/** True for localhost / loopback hosts, where unencrypted dev traffic is acceptable. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/**
 * Guard the credential channel. Returns true when the token will cross an
 * unencrypted-but-permitted link (loopback, or non-HTTPS with explicit opt-in)
 * so the caller can warn; false for a secure HTTPS channel. Refuses (exits)
 * when a token would be sent over plaintext to a remote host without opt-in.
 * Never includes the token in any message.
 */
async function assertTokenChannel(serverUrl: string, insecure: boolean): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return fail(`Invalid server URL: ${serverUrl}`);
  }

  if (url.protocol === 'https:') return false;
  if (isLoopbackHost(url.hostname)) return true;
  if (insecure || process.env.MCPMAKE_INSECURE === '1') return true;

  return fail(
    `Refusing to send the deploy token to ${serverUrl} over an unencrypted (non-HTTPS) channel. ` +
      'Use an https:// URL, or pass --insecure (or set MCPMAKE_INSECURE=1) to override for trusted networks.',
  );
}

/** Redact a secret to its last 4 chars unless the user explicitly opted to reveal it. */
function formatIssuedToken(token: string, show: boolean): string {
  if (show) return token;
  if (!token) return '(none)';
  const tail = token.length > 4 ? token.slice(-4) : '';
  return `(redacted — ends with …${tail}; re-run with --show-token to reveal)`;
}

/**
 * Stringify the Claude Desktop config, scrubbing the issued bearer token from
 * the output unless the user opted in, so it is never echoed to stdout.
 */
function formatClaudeConfig(
  config: Record<string, unknown>,
  bearerToken: string,
  show: boolean,
): string {
  const json = JSON.stringify(config, null, 2);
  if (show || !bearerToken) return json;
  return json.split(bearerToken).join('<REDACTED_TOKEN>');
}

/**
 * POST multipart form data to the hosting backend.
 */
function postMultipart(
  serverUrl: string,
  path: string,
  boundary: string,
  body: Buffer,
  token?: string,
): Promise<DeployResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const transport = url.protocol === 'https:' ? https : http;

    const headers: Record<string, string | number> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');

          if (res.statusCode && res.statusCode >= 400) {
            try {
              const err = JSON.parse(responseBody);
              reject(new Error(err.error ?? `Server returned ${res.statusCode}`));
            } catch {
              reject(new Error(`Server returned ${res.statusCode}: ${responseBody}`));
            }
            return;
          }

          try {
            resolve(JSON.parse(responseBody));
          } catch {
            reject(new Error(`Invalid response from server: ${responseBody}`));
          }
        });
      },
    );

    req.on('error', (err) => {
      reject(new Error(`Connection failed: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}
