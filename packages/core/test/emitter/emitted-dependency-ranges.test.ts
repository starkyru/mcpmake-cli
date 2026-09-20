/**
 * Every dependency the generator emits must be bounded ABOVE.
 *
 * Regression this pins: `requirements.txt.hbs` shipped `mcp>=1.0.0` with no upper
 * bound. The Python SDK released `mcp` 2.0.0 on 2026-07-28 (PyPI JSON API), which
 * deleted `mcp.server.fastmcp` — the exact module `server.py.hbs` imports. A clean
 * `pip install -r requirements.txt` therefore resolved `mcp` 2.2.0 and every
 * generated Python server died at import with
 * `ModuleNotFoundError: No module named 'mcp.server.fastmcp'`.
 *
 * Evidence for the bounds asserted below (all primary, fetched 19 Sep 2026):
 *   - `mcp/server/fastmcp/__init__.py` in modelcontextprotocol/python-sdk is
 *     404 at tags v1.0.0 and v1.1.0, 200 from v1.2.0 through v1.30.0, and 404
 *     again at v2.0.0 / v2.2.0. `FastMCP` and the `tool(name=...)` decorator the
 *     template uses both appear in v1.2.0 — that is the true floor, so the old
 *     `>=1.0.0` floor was itself wrong.
 *   - PyPI: pydantic latest is 2.13.5 (no 3.x), python-dotenv 1.2.3 (no 2.x),
 *     httpx 0.28.1 stable with 1.0 already in dev prereleases.
 *
 * These tests render the REAL templates through the REAL emitters for the repo's
 * petstore fixture. Expected strings are hand-written from the evidence above —
 * never read back out of the template, which would pass by construction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadOpenApiSpec } from '../../src/parser/openapi-loader.js';
import { extractOperations } from '../../src/parser/operation-extractor.js';
import { buildAllTools } from '../../src/transformer/tool-builder.js';
import { detectAuthSchemes } from '../../src/transformer/auth-detector.js';
import { emitProject, emitPythonProject } from '../../src/emitter/index.js';
import type { ProjectManifest } from '../../src/types/index.js';
import type { OpenAPIV3 } from 'openapi-types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

/** Build a manifest from the repo's petstore fixture via the real pipeline. */
async function petstoreManifest(): Promise<ProjectManifest> {
  const { api } = await loadOpenApiSpec(resolve(FIXTURES, 'petstore.yaml'));
  const { operations, baseUrl, securitySchemes } = extractOperations(api as OpenAPIV3.Document);
  const { authSchemes, envVars } = detectAuthSchemes(securitySchemes);
  return {
    serverName: 'petstore-deps',
    transport: 'stdio',
    serverVersion: '1.0.0',
    baseUrl,
    tools: buildAllTools(operations),
    authSchemes,
    envVars: [
      { name: 'BASE_URL', description: 'API base URL', required: true, example: baseUrl },
      ...envVars,
    ],
  };
}

/**
 * Split a rendered requirements.txt into its dependency lines, dropping blanks
 * and comments. This parses the emitted artifact; it does not re-derive it.
 */
function requirementLines(rendered: string): string[] {
  return rendered
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * A requirement is bounded above when its specifier set constrains the version
 * from the top: a `<`/`<=` ceiling, an exact `==` pin, or a `~=` compatible
 * release. A bare `>=`/`>` floor is NOT bounded — that is the defect.
 */
function hasUpperBound(line: string): boolean {
  const specifiers = line.split(',').map((s) => s.trim());
  return specifiers.some((s) => /(<=?|==|~=)\s*\d/.test(s));
}

describe('emitted dependency ranges are bounded above', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-deps-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('python requirements.txt pins mcp below the breaking 2.x major', async () => {
    await emitPythonProject(await petstoreManifest(), { outputDir, force: true, dryRun: false });
    const rendered = await readFile(join(outputDir, 'requirements.txt'), 'utf8');

    // Exact lines, hand-written. `mcp` 2.x removed `mcp.server.fastmcp`; 1.2.0 is
    // the first release that has it.
    expect(requirementLines(rendered)).toEqual([
      'mcp>=1.2.0,<2',
      'httpx>=0.27.0,<1',
      'pydantic>=2.0.0,<3',
      'python-dotenv>=1.0.0,<2',
    ]);
  });

  it('the emitted python server imports the module the pinned mcp major provides', async () => {
    await emitPythonProject(await petstoreManifest(), { outputDir, force: true, dryRun: false });
    const [reqs, server] = await Promise.all([
      readFile(join(outputDir, 'requirements.txt'), 'utf8'),
      readFile(join(outputDir, 'server.py'), 'utf8'),
    ]);

    // The template is written against the v1 FastMCP API. If either half of this
    // pair is changed alone, the generated server breaks on a clean install.
    expect(server).toContain('from mcp.server.fastmcp import FastMCP');
    const mcpLine = requirementLines(reqs).find((l) => l.startsWith('mcp'));
    expect(mcpLine).toBe('mcp>=1.2.0,<2');
  });

  it('no emitted requirement line is open-ended', async () => {
    await emitPythonProject(await petstoreManifest(), { outputDir, force: true, dryRun: false });
    const rendered = await readFile(join(outputDir, 'requirements.txt'), 'utf8');

    const lines = requirementLines(rendered);
    expect(lines.length).toBeGreaterThan(0);
    const unbounded = lines.filter((l) => !hasUpperBound(l));
    expect(unbounded).toEqual([]);
  });

  it('typescript package.json deps are capped below their next major', async () => {
    await emitProject(await petstoreManifest(), { outputDir, force: true, dryRun: false });
    const pkg = JSON.parse(await readFile(join(outputDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    // `@modelcontextprotocol/sdk` tops out at 1.30.0 on npm — the 2026-07-28 v2
    // line shipped under NEW package names (`@modelcontextprotocol/server@2.0.0`
    // and friends), which a caret on the old name cannot reach. `zod` 4.x exists
    // and the templates are written for 3.x; the caret excludes it.
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBe('^1.12.0');
    expect(pkg.dependencies['zod']).toBe('^3.24.0');

    // Every range must be a caret or an exact pin — never `>=`, `*` or `latest`.
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(range, `${name} must not be open-ended`).toMatch(/^(\^|~)?\d+\.\d+\.\d+/);
    }
  });
});
