/**
 * Real-world spec corpus (HEAVY tier): the generator must handle 10 public API
 * definitions (see ./manifest.ts) end-to-end, per spec:
 *
 *  1. node generation succeeds with the EXACT expected tool inventory;
 *  2. the generated node project compiles (tsc, emitting dist/ for step 3);
 *  3. the node server boots, completes the MCP handshake, and `tools/list`
 *     returns exactly the manifest's tool count with well-formed unique names;
 *  4. python generation succeeds and registers the IDENTICAL tool inventory —
 *     the cross-language contract on real specs (runtime call semantics are
 *     cross-compared by the parity suite on a controlled fixture);
 *  5. the python server imports cleanly in a venv (decorators run at import,
 *     so this executes every tool registration).
 *
 * This corpus exists because it catches what fixtures can't: the Swagger 2.0
 * definitions-$ref bug, zod-v4 codegen against zod-v3 deps, duplicate config
 * properties, and garbage spec defaults were ALL found by these specs.
 *
 * Provisioning: one shared npm install at the corpus parent dir (generated
 * projects resolve deps by walking up), one shared python venv. Both
 * skip-cleanly offline; spec downloads are cached + sha256-pinned
 * (helpers/corpus-cache.ts).
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from '../helpers/run-cli.js';
import { ensureBuilt } from '../helpers/build-guard.js';
import { makeTempDir } from '../helpers/sandbox.js';
import { E2E, E2E_HEAVY } from '../helpers/gating.js';
import {
  npmInstall,
  provisionPythonVenv,
  pythonImportServer,
  type ProvisionResult,
  type PythonEnv,
} from '../helpers/provision.js';
import { startMcpServer, type McpStdioClient } from '../helpers/mcp-client.js';
import { fetchCorpusSpec } from '../helpers/corpus-cache.js';
import { CORPUS, type CorpusEntry } from './manifest.js';

const execFile = promisify(execFileCb);
const HEAVY = E2E && E2E_HEAVY;

/** Union of the deps every generated node project needs, installed ONCE at the
 * parent dir — projects resolve them by node_modules walk-up. Mirrors the
 * generated package.json (plus typescript/@types for tsc). */
const SHARED_DEPS_PACKAGE_JSON = {
  name: 'mcpmake-corpus-shared-deps',
  private: true,
  dependencies: {
    '@modelcontextprotocol/sdk': '^1.12.0',
    zod: '^3.24.0',
  },
  devDependencies: {
    '@types/node': '^22.0.0',
    typescript: '^5.8.0',
    // Boot path for typecheck:false entries (kubernetes) — mirrors the
    // generated project's own `dev` script.
    tsx: '^4.19.0',
  },
};

interface SpecState {
  specPath: string | null;
  skipReason?: string;
  nodeDir: string;
  pyDir: string;
  /** Runtime tool names from the node server's tools/list (set by the boot test). */
  nodeRuntimeTools?: string[];
}

/** `tsc -p <project>` with the shared typescript, EMITTING dist/ for the boot
 * test. Returns exit code + diagnostics instead of throwing: a non-zero exit
 * is a generated-code bug the test asserts on with the compiler output. */
async function tscBuild(
  parentDir: string,
  projectDir: string,
): Promise<{ code: number; output: string }> {
  const tsc = join(parentDir, 'node_modules', '.bin', 'tsc');
  // Discord/kubernetes-scale projects (240–1100 tool files with huge union
  // types) exceed node's default old-space during checking — give tsc room.
  // kubernetes (1106 tools) peaks past 6 GB in emit mode.
  const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' };
  try {
    const { stdout, stderr } = await execFile(tsc, ['-p', projectDir], {
      timeout: 280_000,
      maxBuffer: 32 * 1024 * 1024,
      env,
    });
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      output: (e.stdout ?? '') + (e.stderr ?? ''),
    };
  }
}

/** Tool names registered in a generated python server: `@server.tool(name="…")`
 * decorators run at import time, so the static inventory IS the runtime one. */
function pythonToolNames(pyDir: string): string[] {
  const source = readFileSync(join(pyDir, 'server.py'), 'utf8');
  return [...source.matchAll(/@server\.tool\(name="([^"]+)"/g)].map((m) => m[1]);
}

/** Node tool inventory from generated file names (kebab-case of the snake_case
 * tool name; index.ts is the barrel, not a tool). */
function nodeToolFileNames(nodeDir: string): string[] {
  return readdirSync(join(nodeDir, 'src', 'tools'))
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .map((f) => f.replace(/\.ts$/, ''));
}

describe.skipIf(!HEAVY)('e2e corpus: 10 real-world API specs', () => {
  let parentDir: string;
  let deps: ProvisionResult = { ok: false, reason: 'not run' };
  let py: PythonEnv = { python: null, reason: 'not run' };
  const states = new Map<string, SpecState>();

  beforeAll(async () => {
    ensureBuilt();
    parentDir = await makeTempDir();
    writeFileSync(
      join(parentDir, 'package.json'),
      JSON.stringify(SHARED_DEPS_PACKAGE_JSON, null, 2),
    );

    // Network-dependent provisioning + downloads in parallel; each failure
    // downgrades to a clean skip, never a red suite.
    const [depsResult, pyResult] = await Promise.all([
      npmInstall(parentDir),
      provisionPythonVenv(parentDir),
      ...CORPUS.map(async (entry) => {
        const fetched = await fetchCorpusSpec(entry);
        states.set(entry.name, {
          specPath: fetched.path,
          skipReason: fetched.path === null ? fetched.reason : undefined,
          nodeDir: join(parentDir, 'node', entry.name),
          pyDir: join(parentDir, 'python', entry.name),
        });
      }),
    ]);
    deps = depsResult as ProvisionResult;
    py = pyResult as PythonEnv;
    if (!deps.ok) console.warn(`[corpus] SKIP compile/boot — ${deps.reason}`);
    if (!py.python) console.warn(`[corpus] SKIP python import — ${py.reason}`);
    for (const [name, st] of states) {
      if (!st.specPath) console.warn(`[corpus] SKIP ${name} — ${st.skipReason}`);
    }
  }, 600_000);

  for (const entry of CORPUS) {
    describe(`${entry.name} (OpenAPI ${entry.specVersion})`, () => {
      it('generates the node project with the exact expected tool inventory', async () => {
        const st = states.get(entry.name)!;
        if (!st.specPath) return; // download skipped cleanly

        const gen = await runCli(['from', 'openapi', st.specPath, '-o', st.nodeDir], {
          cwd: parentDir,
        });
        expect(gen.code, combined(gen)).toBe(0);

        const pkg = JSON.parse(readFileSync(join(st.nodeDir, 'package.json'), 'utf8')) as {
          name: string;
        };
        expect(pkg.name).toBe(entry.serverName);

        const files = nodeToolFileNames(st.nodeDir);
        expect(files).toHaveLength(entry.toolCount);
        for (const tool of entry.sampleTools) {
          expect(files).toContain(tool.replaceAll('_', '-'));
        }
      }, 240_000);

      it('generated node project compiles (tsc)', async () => {
        const st = states.get(entry.name)!;
        if (!st.specPath || !deps.ok || !existsSync(st.nodeDir)) return;
        if (!entry.typecheck) return; // documented scale limitation — see manifest

        const result = await tscBuild(parentDir, st.nodeDir);
        expect(result.code, `tsc diagnostics:\n${result.output}`).toBe(0);
        expect(existsSync(join(st.nodeDir, 'dist', 'index.js'))).toBe(true);
      }, 300_000);

      it('node server boots and tools/list matches the manifest exactly', async () => {
        const st = states.get(entry.name)!;
        const viaDist = entry.typecheck; // typecheck:false boots via tsx instead
        if (!st.specPath || !deps.ok) return;
        if (viaDist && !existsSync(join(st.nodeDir, 'dist', 'index.js'))) return;
        if (!viaDist && !existsSync(join(st.nodeDir, 'src', 'index.ts'))) return;

        let client: McpStdioClient | undefined;
        try {
          const { client: c, serverInfo } = await startMcpServer({
            cwd: st.nodeDir,
            // No tools/call is made; the URL only has to parse.
            env: { BASE_URL: 'http://127.0.0.1:9' },
            requestTimeoutMs: 60_000,
            ...(viaDist
              ? {}
              : {
                  command: join(parentDir, 'node_modules', '.bin', 'tsx'),
                  args: ['src/index.ts'],
                }),
          });
          client = c;
          expect(serverInfo.name).toBe(entry.serverName);

          const tools = await client.listTools();
          const names = tools.map((t) => t.name);
          expect(names).toHaveLength(entry.toolCount);
          expect(new Set(names).size).toBe(entry.toolCount); // no duplicates
          for (const name of names) {
            expect(name).toMatch(/^[a-z0-9_]+$/);
          }
          for (const sample of entry.sampleTools) {
            expect(names).toContain(sample);
          }
          st.nodeRuntimeTools = [...names].sort();
        } finally {
          await client?.close();
        }
      }, 120_000);

      it('python server registers the IDENTICAL tool inventory (cross-language)', async () => {
        const st = states.get(entry.name)!;
        if (!st.specPath) return;

        const gen = await runCli(
          ['from', 'openapi', st.specPath, '-o', st.pyDir, '--format', 'python'],
          { cwd: parentDir },
        );
        expect(gen.code, combined(gen)).toBe(0);

        const pyNames = pythonToolNames(st.pyDir).sort();
        // Prefer the node server's RUNTIME inventory; fall back to the
        // generated file names (same names, kebab-cased) when the boot test
        // was skipped (offline) so the cross-language check still runs.
        const nodeNames =
          st.nodeRuntimeTools ??
          (existsSync(st.nodeDir)
            ? nodeToolFileNames(st.nodeDir)
                .map((f) => f.replaceAll('-', '_'))
                .sort()
            : null);
        expect(pyNames).toHaveLength(entry.toolCount);
        if (nodeNames) {
          expect(pyNames).toEqual(nodeNames);
        }
      }, 240_000);

      it('python server imports cleanly (registrations execute)', async () => {
        const st = states.get(entry.name)!;
        if (!st.specPath || !py.python || !existsSync(join(st.pyDir, 'server.py'))) return;

        const result = await pythonImportServer(py.python, st.pyDir);
        expect(result.code, `python import:\n${result.stdout}\n${result.stderr}`).toBe(0);
      }, 180_000);
    });
  }
});
