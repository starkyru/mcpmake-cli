/**
 * Sprint E4 — `mcpmake publish` end-to-end (local filesystem, no network).
 *
 * Builds a throwaway project (package.json + git remote + tool handler files),
 * runs the built bin, then reads back the manifests it actually wrote:
 *   - --registry smithery → smithery.yaml
 *   - --registry glama    → glama.json
 *   - --registry official → server.json + package.json gains "mcpName"
 *   - --registry official --push --yes with no mcp-publisher on PATH → ENOENT branch
 *
 * The harness env inherits only PATH; mcp-publisher is not installed, so the
 * --push path deterministically hits the "not installed" branch.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as yamlParse } from 'yaml';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { E2E } from './helpers/gating.js';

interface ProjectOpts {
  name?: string;
  version?: string;
  description?: string;
  remote?: string;
  tools?: Array<{ name: string; description: string }>;
}

/** Scaffold a minimal generated-server-shaped project with a git origin remote. */
function makeProject(dir: string, opts: ProjectOpts = {}): void {
  const name = opts.name ?? 'my-cool-mcp';
  const version = opts.version ?? '2.1.0';
  const description = opts.description ?? 'A cool MCP server';
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, description }, null, 2) + '\n',
  );
  mkdirSync(join(dir, 'src', 'tools'), { recursive: true });
  // stdio entry (no HTTP transport markers) → transport detected as "stdio".
  writeFileSync(join(dir, 'src', 'index.ts'), '// stdio server\nserver.connect(transport);\n');
  const tools = opts.tools ?? [
    { name: 'get_weather', description: 'Get the current weather' },
    { name: 'list_cities', description: 'List available cities' },
  ];
  for (const t of tools) {
    writeFileSync(
      join(dir, 'src', 'tools', `${t.name}.ts`),
      `server.registerTool('${t.name}', { description: '${t.description}', inputSchema: {} }, async () => ({}));\n`,
    );
  }
  // A real git remote so the official flow can derive the registry name.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (opts.remote !== null) {
    execFileSync(
      'git',
      ['remote', 'add', 'origin', opts.remote ?? 'https://github.com/me/my-cool-mcp.git'],
      {
        cwd: dir,
      },
    );
  }
}

describe.skipIf(!E2E)('e2e publish: registry manifests (local fs)', () => {
  beforeAll(() => ensureBuilt());

  it('--registry smithery writes a smithery.yaml with the project name + tools', async () => {
    await withTempDir(async (dir) => {
      makeProject(dir);
      const r = await runCli(['publish', dir, '--registry', 'smithery'], { cwd: dir });
      expect(r.code).toBe(0);
      expect(combined(r)).toContain('Found 2 tool(s)');

      const yamlPath = join(dir, 'smithery.yaml');
      expect(existsSync(yamlPath)).toBe(true);
      const parsed = yamlParse(readFileSync(yamlPath, 'utf8')) as {
        name: string;
        version: string;
        transport: string;
        tools: Array<{ name: string; description: string }>;
      };
      expect(parsed.name).toBe('my-cool-mcp');
      expect(parsed.version).toBe('2.1.0');
      expect(parsed.transport).toBe('stdio');
      expect(parsed.tools).toEqual([
        { name: 'get_weather', description: 'Get the current weather' },
        { name: 'list_cities', description: 'List available cities' },
      ]);
      // smithery-only run must not also emit the glama manifest.
      expect(existsSync(join(dir, 'glama.json'))).toBe(false);
    });
  });

  it('--registry glama writes a glama.json with the project name + tools', async () => {
    await withTempDir(async (dir) => {
      makeProject(dir);
      const r = await runCli(['publish', dir, '--registry', 'glama'], { cwd: dir });
      expect(r.code).toBe(0);

      const jsonPath = join(dir, 'glama.json');
      expect(existsSync(jsonPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
        name: string;
        version: string;
        transport: string;
        tools: Array<{ name: string; description: string }>;
      };
      expect(parsed.name).toBe('my-cool-mcp');
      expect(parsed.version).toBe('2.1.0');
      expect(parsed.transport).toBe('stdio');
      expect(parsed.tools).toEqual([
        { name: 'get_weather', description: 'Get the current weather' },
        { name: 'list_cities', description: 'List available cities' },
      ]);
      expect(existsSync(join(dir, 'smithery.yaml'))).toBe(false);
    });
  });

  it('--registry official writes server.json and sets mcpName in package.json', async () => {
    await withTempDir(async (dir) => {
      makeProject(dir);
      const r = await runCli(['publish', dir, '--registry', 'official'], { cwd: dir });
      expect(r.code).toBe(0);
      const out = combined(r);
      // Name derived from the github origin remote: io.github.<owner>/<repo>.
      expect(out).toContain('io.github.me/my-cool-mcp');

      const serverJsonPath = join(dir, 'server.json');
      expect(existsSync(serverJsonPath)).toBe(true);
      const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf8')) as {
        name: string;
        version: string;
        packages: Array<{ registryType: string; identifier: string; transport: { type: string } }>;
        repository: { url: string };
      };
      expect(serverJson.name).toBe('io.github.me/my-cool-mcp');
      expect(serverJson.version).toBe('2.1.0');
      expect(serverJson.packages[0].registryType).toBe('npm');
      expect(serverJson.packages[0].identifier).toBe('my-cool-mcp');
      expect(serverJson.packages[0].transport.type).toBe('stdio');
      expect(serverJson.repository.url).toBe('https://github.com/me/my-cool-mcp');

      // package.json gains the validation marker matching the registry name.
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        mcpName?: string;
      };
      expect(pkg.mcpName).toBe('io.github.me/my-cool-mcp');
    });
  });

  it('--push with no mcp-publisher on PATH hits the ENOENT "not installed" branch (exit 1)', async () => {
    await withTempDir(async (dir) => {
      makeProject(dir);
      const r = await runCli(['publish', dir, '--registry', 'official', '--push', '--yes'], {
        cwd: dir,
      });
      // server.json is generated before the publisher runs; the publisher then
      // fails because mcp-publisher is not on the (scrubbed) PATH.
      expect(existsSync(join(dir, 'server.json'))).toBe(true);
      expect(r.code).toBe(1);
      const out = combined(r);
      expect(out).toContain('mcp-publisher is not installed or not on PATH.');
      expect(out).toContain('https://modelcontextprotocol.io/registry/quickstart');
    });
  });

  it('no --registry writes BOTH smithery.yaml and glama.json', async () => {
    await withTempDir(async (dir) => {
      makeProject(dir, { tools: [{ name: 'only_tool', description: 'one tool' }] });
      const r = await runCli(['publish', dir], { cwd: dir });
      expect(r.code).toBe(0);
      expect(combined(r)).toContain('Found 1 tool(s)');
      expect(existsSync(join(dir, 'smithery.yaml'))).toBe(true);
      expect(existsSync(join(dir, 'glama.json'))).toBe(true);
    });
  });

  it('rejects an unknown --registry value with exit 1', async () => {
    await withTempDir(async (dir) => {
      makeProject(dir);
      const r = await runCli(['publish', dir, '--registry', 'bogus'], { cwd: dir });
      expect(r.code).toBe(1);
      expect(combined(r)).toContain(
        'Invalid registry. Use "official", "smithery", "glama", or omit for both.',
      );
    });
  });

  it('rejects a directory without package.json with exit 1', async () => {
    await withTempDir(async (dir) => {
      const r = await runCli(['publish', dir], { cwd: dir });
      expect(r.code).toBe(1);
      expect(combined(r)).toContain(`Not a valid project directory (no package.json): ${dir}`);
    });
  });
});
