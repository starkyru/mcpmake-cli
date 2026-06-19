import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadOpenApiSpec } from '../../src/parser/openapi-loader.js';
import { extractOperations } from '../../src/parser/operation-extractor.js';
import { buildAllTools } from '../../src/transformer/tool-builder.js';
import { detectAuthSchemes } from '../../src/transformer/auth-detector.js';
import { emitProject } from '../../src/emitter/index.js';
import { pathExists } from '../../src/utils/fs.js';
import type { OpenAPIV3 } from 'openapi-types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

describe('integration: full pipeline', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-test-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('generates a complete project from petstore spec', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const { operations, baseUrl, securitySchemes, info } = extractOperations(
      api as OpenAPIV3.Document,
    );
    const tools = buildAllTools(operations);
    const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

    const manifest = {
      serverName: 'test-petstore',
      transport: 'stdio' as const,
      serverVersion: '1.0.0',
      baseUrl,
      tools,
      authSchemes,
      envVars: [
        { name: 'BASE_URL', description: 'API base URL', required: true, example: baseUrl },
        ...envVars,
      ],
    };

    await emitProject(manifest, { outputDir, force: true, dryRun: false });

    // Verify all expected files exist
    const expectedFiles = [
      'package.json',
      'tsconfig.json',
      '.env.example',
      '.gitignore',
      'src/index.ts',
      'src/config.ts',
      'src/auth.ts',
      'src/http.ts',
      'src/types.ts',
      'src/tools/index.ts',
      'src/tools/list-pets.ts',
      'src/tools/create-pet.ts',
      'src/tools/show-pet-by-id.ts',
      'src/tools/delete-pet.ts',
    ];

    for (const file of expectedFiles) {
      expect(await pathExists(resolve(outputDir, file)), `${file} should exist`).toBe(true);
    }
  });

  it('generates correct tool count', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const { operations } = extractOperations(api as OpenAPIV3.Document);
    expect(operations).toHaveLength(4);
  });

  it('generates valid package.json', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const { operations, baseUrl, securitySchemes, info } = extractOperations(
      api as OpenAPIV3.Document,
    );
    const tools = buildAllTools(operations);
    const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

    await emitProject(
      {
        serverName: 'test-petstore',
        serverVersion: '2.0.0',
        baseUrl,
        tools,
        authSchemes,
        envVars,
      },
      { outputDir, force: true, dryRun: false },
    );

    const pkgJson = JSON.parse(await readFile(resolve(outputDir, 'package.json'), 'utf-8'));
    expect(pkgJson.name).toBe('test-petstore');
    expect(pkgJson.version).toBe('2.0.0');
    expect(pkgJson.type).toBe('module');
    expect(pkgJson.dependencies).toHaveProperty('@modelcontextprotocol/sdk');
    expect(pkgJson.dependencies).toHaveProperty('zod');
  });

  it('generates .env.example with auth vars', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const { operations, baseUrl, securitySchemes } = extractOperations(api as OpenAPIV3.Document);
    const tools = buildAllTools(operations);
    const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

    await emitProject(
      {
        serverName: 'test-petstore',
        serverVersion: '1.0.0',
        baseUrl,
        tools,
        authSchemes,
        envVars: [{ name: 'BASE_URL', description: 'API base URL', required: true }, ...envVars],
      },
      { outputDir, force: true, dryRun: false },
    );

    const envExample = await readFile(resolve(outputDir, '.env.example'), 'utf-8');
    expect(envExample).toContain('BASE_URL=');
    expect(envExample).toContain('API_KEY=');
    expect(envExample).toContain('BEARER_TOKEN=');
  });

  it('emits the MCP 2026-07-28 HTTP server with discover, tasks, and .well-known', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const { operations, baseUrl } = extractOperations(api as OpenAPIV3.Document);
    const tools = buildAllTools(operations);
    // Mark one tool async to exercise the Tasks/isAsync branch.
    (tools[0] as { isAsync?: boolean }).isAsync = true;

    await emitProject(
      {
        serverName: 'rc-server',
        serverVersion: '1.0.0',
        baseUrl,
        transport: 'http' as const,
        tools,
        authSchemes: [
          { type: 'oauth2' as const, envVarName: 'OAUTH2_TOKEN', description: 'OAuth2' },
        ],
        envVars: [
          { name: 'BASE_URL', description: 'API base URL', required: true, example: baseUrl },
        ],
      },
      { outputDir, force: true, dryRun: false },
    );

    const index = await readFile(resolve(outputDir, 'src/index.ts'), 'utf-8');
    // Stateless-by-default toggle + per-request transport factory.
    expect(index).toContain("process.env.MCP_STATEFUL === 'true'");
    expect(index).toContain('sessionIdGenerator: undefined');
    expect(index).toContain('function createMcpServer(');
    // Stateful mode keeps a per-session transport map keyed by Mcp-Session-Id
    // (a single shared transport cannot multiplex concurrent sessions).
    expect(index).toContain('onsessioninitialized');
    expect(index).toContain("headerValue(req.headers['mcp-session-id'])");
    // server/discover + routing-header observability + Tasks RPC dispatch.
    expect(index).toContain("rpcMethod === 'server/discover'");
    expect(index).toContain("req.headers['mcp-method']");
    expect(index).toContain('handleTaskRpc(');
    // CIMD-corrected: RFC 8414 well-known route (no /.well-known/mcp.json).
    expect(index).toContain('/.well-known/oauth-authorization-server');
    expect(index).not.toContain('/.well-known/mcp.json');
    // parsedBody replay into the SDK transport.
    expect(index).toContain('handleRequest(req, res, parsedBody)');

    // Tasks extension wiring: tasks/list removed, update added.
    const taskHandlers = await readFile(resolve(outputDir, 'src/task-handlers.ts'), 'utf-8');
    expect(taskHandlers).toContain('export function handleTaskRpc');
    expect(taskHandlers).toContain("case 'tasks/update'");
    expect(taskHandlers).toContain('tasks/list is not supported');

    // Async tool returns a task handle.
    const asyncTool = await readFile(resolve(outputDir, 'src/tools/list-pets.ts'), 'utf-8');
    expect(asyncTool).toContain('createTask(');
    expect(asyncTool).toContain('structuredContent: { task: handle }');

    // Generated tool tests are real registration/schema tests, not placeholders.
    const toolTest = await readFile(resolve(outputDir, 'test/tools/list-pets.test.ts'), 'utf-8');
    expect(toolTest).not.toContain('expect(true).toBe(true)');
    expect(toolTest).toContain('registers exactly one tool');
    expect(toolTest).toContain('well-formed input schema');
  });

  it('dry-run does not write files', async () => {
    const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
    const { operations, baseUrl, securitySchemes } = extractOperations(api as OpenAPIV3.Document);
    const tools = buildAllTools(operations);
    const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);

    await emitProject(
      {
        serverName: 'test-petstore',
        serverVersion: '1.0.0',
        baseUrl,
        tools,
        authSchemes,
        envVars,
      },
      { outputDir, force: true, dryRun: true },
    );

    expect(await pathExists(resolve(outputDir, 'package.json'))).toBe(false);
  });
});
