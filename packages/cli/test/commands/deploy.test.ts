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

describe('deploy command multipart MIME injection guards (A4-8)', () => {
  let tmp: string;
  let specPath: string;
  let capturedBody: string;
  let backend: { url: string; close: () => Promise<void> };
  let logSpies: ReturnType<typeof vi.spyOn>[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  /** Backend that captures the raw request body for assertion. */
  async function startCapturingBackend(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        capturedBody = Buffer.concat(chunks).toString('binary');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            slug: 'demo',
            endpoint: 'http://example/mcp',
            bearerToken: 'tok_test',
            status: 'ok',
            toolCount: 0,
            claudeDesktopConfig: {},
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

  beforeEach(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'mcpmake-deploy-mime-'));
    specPath = resolve(tmp, 'spec.json');
    await writeFile(specPath, JSON.stringify({ openapi: '3.0.0' }));
    capturedBody = '';
    logSpies = (['info', 'success', 'log', 'error', 'warn'] as const).map((m) =>
      vi.spyOn(logger, m).mockImplementation(() => {}),
    );
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    backend = await startCapturingBackend();
  });

  afterEach(async () => {
    logSpies.forEach((s) => s.mockRestore());
    warnSpy.mockRestore();
    await backend.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('strips CR and LF from --name before embedding in MIME headers', async () => {
    await deployCommand.run!({
      args: {
        spec: specPath,
        server: backend.url,
        name: 'evil\r\nContent-Disposition: form-data; name="injected"',
        token: undefined,
        insecure: false,
        'show-token': false,
      },
      rawArgs: [],
    } as never);

    // The injected CRLF must not appear in the multipart body
    expect(capturedBody).not.toContain('\r\nContent-Disposition: form-data; name="injected"');
    // The original name value (minus the CRLF) should still be present
    expect(capturedBody).toContain('evil');
  });

  it('strips CR and LF from the filename and escapes double-quotes', async () => {
    // Rename spec file to contain a double-quote and newline in the name
    const maliciousPath = resolve(tmp, 'bad"name.json');
    await writeFile(maliciousPath, JSON.stringify({ openapi: '3.0.0' }));

    await deployCommand.run!({
      args: {
        spec: maliciousPath,
        server: backend.url,
        token: undefined,
        insecure: false,
        'show-token': false,
      },
      rawArgs: [],
    } as never);

    // The filename attribute must not contain an unescaped double-quote
    // (which would close the filename="..." early).
    const filenameAttr = capturedBody.match(/filename="([^"\\]|\\.)*"/)?.[0] ?? '';
    expect(filenameAttr).toBeTruthy();
    // A raw " in the original name must be escaped as \"
    expect(capturedBody).toContain('\\"name.json');
  });

  it('escapes backslashes in the filename before escaping double-quotes (R2-D)', async () => {
    // A filename with a backslash immediately before a quote: foo\"bar.json
    // Without escaping backslash first: foo\"bar → foo\\"bar (the backslash
    // itself is not doubled, breaking the MIME quoted-string).
    // With correct order (backslash first, then quote): foo\\\"bar.json
    const backslashPath = resolve(tmp, 'foo\\"bar.json');
    await writeFile(backslashPath, JSON.stringify({ openapi: '3.0.0' }));

    await deployCommand.run!({
      args: {
        spec: backslashPath,
        server: backend.url,
        token: undefined,
        insecure: false,
        'show-token': false,
      },
      rawArgs: [],
    } as never);

    // The literal backslash must be doubled before the escaped quote appears.
    // Expected escaped sequence inside filename="...": foo\\\"bar.json
    expect(capturedBody).toContain('foo\\\\\\"bar.json');
  });
});
