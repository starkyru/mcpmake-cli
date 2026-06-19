import { defineConfigurableCommand } from '@mcpmake/core';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';

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
      description: 'Cloud server URL',
      default: 'http://localhost:3001',
    },
    token: {
      type: 'string',
      alias: 't',
      description: 'Admin token (or set MCPMAKE_ADMIN_TOKEN) for gated backends',
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

    logger.info(`Deploying spec: ${specPath}`);
    const serverUrl = args.server;
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

    // POST to the hosting backend
    logger.info('Uploading spec...');

    const adminToken = args.token ?? process.env.MCPMAKE_ADMIN_TOKEN;

    try {
      const result = await postMultipart(serverUrl, '/api/servers', boundary, body, adminToken);

      logger.success('Server deployed!');
      logger.info('');
      logger.info(`  Slug:     ${result.slug}`);
      logger.info(`  Endpoint: ${result.endpoint}`);
      logger.info(`  Token:    ${result.bearerToken}`);
      logger.info(`  Tools:    ${result.toolCount}`);
      logger.info('');
      logger.info('Claude Desktop config (add to claude_desktop_config.json):');
      logger.info('');
      logger.info(JSON.stringify(result.claudeDesktopConfig, null, 2));
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

/**
 * POST multipart form data to the hosting backend.
 */
function postMultipart(
  serverUrl: string,
  path: string,
  boundary: string,
  body: Buffer,
  adminToken?: string,
): Promise<DeployResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const transport = url.protocol === 'https:' ? https : http;

    const headers: Record<string, string | number> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    };
    if (adminToken) {
      headers['Authorization'] = `Bearer ${adminToken}`;
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
