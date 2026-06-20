import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { logger } from '@mcpmake/core';
import deployCommand from '../../src/commands/deploy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ISSUED_TOKEN = 'super-secret-issued-token-abcd1234';
const ADMIN_TOKEN = 'admin-secret-token-zzzz';

/** Build the citty-style context the configurable-command wrapper expects. */
function ctx(overrides: Record<string, unknown>) {
  return {
    args: {
      name: undefined,
      token: ADMIN_TOKEN,
      insecure: false,
      'show-token': false,
      ...overrides,
    },
    rawArgs: [],
  } as never;
}

/** Spin up a throwaway backend that returns a deploy result echoing the issued token. */
async function startBackend(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          slug: 'demo',
          endpoint: 'http://example/mcp',
          bearerToken: ISSUED_TOKEN,
          status: 'ok',
          toolCount: 1,
          claudeDesktopConfig: {
            mcpServers: { demo: { headers: { Authorization: `Bearer ${ISSUED_TOKEN}` } } },
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('deploy command credential exposure (M6)', () => {
  let specPath: string;
  let tmp: string;
  let stdout: string;
  let warnings: string[];
  let logSpies: ReturnType<typeof vi.spyOn>[];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'mcpmake-deploy-'));
    specPath = resolve(tmp, 'spec.json');
    await writeFile(specPath, JSON.stringify({ openapi: '3.0.0' }));

    stdout = '';
    warnings = [];
    delete process.env.MCPMAKE_ADMIN_TOKEN;
    delete process.env.MCPMAKE_INSECURE;
    // The command logs via consola, whose level/stream behaviour varies in test
    // env; capture at the logger boundary so we see exactly what the user would.
    const capture = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    logSpies = (['info', 'success', 'log', 'error'] as const).map((m) =>
      vi.spyOn(logger, m).mockImplementation(capture as never),
    );
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warnings.push(a.map(String).join(' '));
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(async () => {
    logSpies.forEach((s) => s.mockRestore());
    warnSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(tmp, { recursive: true, force: true });
  });

  it('refuses to send the admin token to a non-HTTPS, non-localhost target', async () => {
    await expect(
      deployCommand.run!(ctx({ spec: specPath, server: 'http://deploy.example.com' })),
    ).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The refusal message must not contain the token.
    expect(stdout).not.toContain(ADMIN_TOKEN);
    expect(warnings.join('\n')).not.toContain(ADMIN_TOKEN);
  });

  it('allows a non-HTTPS remote target with --insecure but warns loudly', async () => {
    // Point at a closed port so we exercise the guard, then fail at the network
    // layer (not the channel check). We only assert the guard let it proceed.
    await expect(
      deployCommand.run!(
        ctx({ spec: specPath, server: 'http://deploy.example.com:1', insecure: true }),
      ),
    ).rejects.toThrow('process.exit called');

    expect(warnings.join('\n')).toMatch(/unencrypted channel/i);
    expect(warnings.join('\n')).not.toContain(ADMIN_TOKEN);
  });

  it('does not print the raw issued token to stdout by default (localhost dev)', async () => {
    const backend = await startBackend();
    try {
      await deployCommand.run!(ctx({ spec: specPath, server: backend.url }));
    } finally {
      await backend.close();
    }

    // Issued token never echoed; redacted form shows only the last 4 chars.
    expect(stdout).not.toContain(ISSUED_TOKEN);
    expect(stdout).toContain('1234');
    expect(stdout).toContain('<REDACTED_TOKEN>');
    // Loopback still warns about the unencrypted channel.
    expect(warnings.join('\n')).toMatch(/unencrypted channel/i);
  });

  it('prints the issued token in full only with --show-token', async () => {
    const backend = await startBackend();
    try {
      await deployCommand.run!(ctx({ spec: specPath, server: backend.url, 'show-token': true }));
    } finally {
      await backend.close();
    }

    expect(stdout).toContain(ISSUED_TOKEN);
  });

  it('does not warn or guard when no token is present over plain HTTP localhost', async () => {
    const backend = await startBackend();
    try {
      await deployCommand.run!(ctx({ spec: specPath, server: backend.url, token: undefined }));
    } finally {
      await backend.close();
    }

    expect(warnings.join('\n')).not.toMatch(/unencrypted channel/i);
  });
});
