import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { importFromStainless } from '../../../src/commands/from/stainless.js';
import { pathExists } from '@mcpmake/core';

const STAINLESS_YML = `
config-version: 2
organization: acme
openapi:
  path: openapi.yml
environments:
  production: https://api.acme.com/v1
  sandbox: https://sandbox.acme.com/v1
client_settings:
  opts:
    api_key:
      type: string
      read_env: ACME_API_KEY
      auth:
        security_scheme: bearerAuth
targets:
  mcp_server:
    code: true
    docs_search: true
resources:
  accounts:
    methods:
      create: post /accounts
      list: get /accounts
      retrieve: get /accounts/{id}
      del: delete /accounts/{id}
  cards:
    methods:
      create: post /cards
    subresources:
      issuing:
        methods:
          create: post /cards/issuing
settings:
  unwrap_response: true
`;

const OPENAPI_YML = `
openapi: 3.0.0
info:
  title: Acme API
  version: 2.3.0
servers:
  - url: https://api.acme.com/v1
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
security:
  - bearerAuth: []
paths:
  /accounts:
    post:
      operationId: createAccount
      summary: Create account
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: object
                    properties:
                      id:
                        type: string
    get:
      operationId: listAccounts
      responses:
        '200':
          description: ok
  /accounts/{id}:
    get:
      operationId: getAccount
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: ok
    delete:
      operationId: deleteAccount
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: gone
  /cards:
    post:
      operationId: createCard
      responses:
        '200':
          description: ok
  /cards/issuing:
    post:
      operationId: createIssuingCard
      responses:
        '200':
          description: ok
`;

describe('importFromStainless (from stainless command)', () => {
  let srcDir: string;
  let outDir: string;

  beforeEach(async () => {
    srcDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-stl-src-'));
    outDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-stl-out-'));
    await writeFile(join(srcDir, 'stainless.yml'), STAINLESS_YML);
    await writeFile(join(srcDir, 'openapi.yml'), OPENAPI_YML);
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  async function toolFilesContent(): Promise<string> {
    const dir = join(outDir, 'src', 'tools');
    const files = await readdir(dir);
    const parts = await Promise.all(
      files.filter((f) => f.endsWith('.ts')).map((f) => readFile(join(dir, f), 'utf-8')),
    );
    return parts.join('\n');
  }

  it('generates an owned per-endpoint server with Stainless tool names', async () => {
    const result = await importFromStainless({
      configPath: join(srcDir, 'stainless.yml'),
      output: outDir,
      transport: 'http',
      force: true,
    });

    expect(result.toolCount).toBe(6);
    expect(result.codeMode).toBe(true);
    expect(result.format).toBe('typescript');
    expect(result.serverName).toBe('acme-api');

    const index = await readFile(join(outDir, 'src', 'tools', 'index.ts'), 'utf-8');
    for (const name of [
      'create_account',
      'list_account',
      'retrieve_account',
      'delete_account',
      'create_card',
      'create_issuing_card',
    ]) {
      expect(index).toContain(`isToolEnabled('${name}')`);
    }
  });

  it('seeds MCP_ENVIRONMENTS + API_ENVIRONMENT into .env.example', async () => {
    await importFromStainless({
      configPath: join(srcDir, 'stainless.yml'),
      output: outDir,
      transport: 'http',
      force: true,
    });
    const env = await readFile(join(outDir, '.env.example'), 'utf-8');
    expect(env).toContain(
      'MCP_ENVIRONMENTS={"production":"https://api.acme.com/v1","sandbox":"https://sandbox.acme.com/v1"}',
    );
    expect(env).toContain('API_ENVIRONMENT=production');
  });

  it('renames the bearer credential env var to read_env (ACME_API_KEY)', async () => {
    await importFromStainless({
      configPath: join(srcDir, 'stainless.yml'),
      output: outDir,
      force: true,
    });
    const config = await readFile(join(outDir, 'src', 'config.ts'), 'utf-8');
    expect(config).toContain('process.env.ACME_API_KEY');
    expect(config).not.toContain('process.env.BEARER_TOKEN');

    const auth = await readFile(join(outDir, 'src', 'auth.ts'), 'utf-8');
    expect(auth).toContain('Bearer ${config.bearerToken}');

    const env = await readFile(join(outDir, '.env.example'), 'utf-8');
    expect(env).toContain('ACME_API_KEY=');
  });

  it('applies the unwrap_response jq filter to the create tool', async () => {
    await importFromStainless({
      configPath: join(srcDir, 'stainless.yml'),
      output: outDir,
      force: true,
    });
    const tools = await toolFilesContent();
    expect(tools).toContain("'create_account'");
    expect(tools).toContain("applyJqFilter(result, '.data')");
  });

  it('lets an explicit --base-url win over the config environments (build + runtime)', async () => {
    await importFromStainless({
      configPath: join(srcDir, 'stainless.yml'),
      output: outDir,
      transport: 'http',
      baseUrl: 'https://proxy.internal/v1',
      force: true,
    });
    const env = await readFile(join(outDir, '.env.example'), 'utf-8');
    expect(env).toContain('BASE_URL=https://proxy.internal/v1');
    // environments seeding suppressed so the runtime resolver honours BASE_URL —
    // only the commented placeholder may remain (no active, line-start seed).
    expect(env).not.toMatch(/^MCP_ENVIRONMENTS=/m);
    expect(env).not.toMatch(/^API_ENVIRONMENT=/m);
  });

  it('does not register skipped operations as tools or resources', async () => {
    // Mark the detail GET /accounts/{id} endpoint non-MCP via x-stainless-skip.
    const spec = OPENAPI_YML.replace(
      'operationId: getAccount',
      'operationId: getAccount\n      x-stainless-skip: true',
    );
    await writeFile(join(srcDir, 'openapi.yml'), spec);
    await importFromStainless({
      configPath: join(srcDir, 'stainless.yml'),
      output: outDir,
      transport: 'http',
      force: true,
    });
    // The skipped op must not leak in as a tool OR a (template) resource.
    const index = await readFile(join(outDir, 'src', 'tools', 'index.ts'), 'utf-8');
    expect(index).not.toContain("isToolEnabled('retrieve_account')");
    if (await pathExists(join(outDir, 'src', 'resources.ts'))) {
      const resources = await readFile(join(outDir, 'src', 'resources.ts'), 'utf-8');
      expect(resources).not.toContain('/accounts/{id}');
    }
  });

  it('respects --spec override + --exclude filtering', async () => {
    const result = await importFromStainless({
      configPath: join(srcDir, 'stainless.yml'),
      spec: join(srcDir, 'openapi.yml'),
      output: outDir,
      exclude: '/cards*',
      force: true,
    });
    // /cards and /cards/issuing excluded → 4 tools left
    expect(result.toolCount).toBe(4);
    expect(await pathExists(join(outDir, 'src', 'tools', 'index.ts'))).toBe(true);
  });
});
