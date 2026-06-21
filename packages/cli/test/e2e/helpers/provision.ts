/**
 * One-time, network-dependent provisioning shared by the Sprint E6 heavy tests.
 *
 * Compiling/importing/running a *generated* project requires its own toolchain
 * that the mcpmake repo does not vendor: the node target needs
 * `@modelcontextprotocol/sdk` + `zod` + `typescript`, the worker target needs
 * `@cloudflare/workers-types` + `typescript`, the python target needs `mcp` +
 * `pydantic` + `httpx` + `python-dotenv` in a venv. Each provision touches the
 * network, so we do it ONCE in a `beforeAll`, cache the result, and reuse the
 * populated `node_modules` / venv across every test in the file (per-test
 * installs would make the suite minutes-long and flaky).
 *
 * Every entry point returns a discriminated result instead of throwing on a
 * tooling/offline failure: a CI box without network (or a python without a
 * buildable `mcp`) must SKIP the heavy assertions cleanly, not turn the suite
 * red for an environmental reason. A genuine *generated-code* failure (tsc
 * error, python ImportError) is the thing we DO want to surface — those are
 * checked by the tests themselves, after a successful provision.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

/** Env scrubbed of loader-hijack vectors for every child we spawn (defense in depth). */
function childEnv(): Record<string, string | undefined> {
  const e = { ...process.env };
  delete e.NODE_OPTIONS;
  delete e.NODE_LOADER;
  return e;
}

export type ProvisionResult = { ok: true } | { ok: false; reason: string };

const INSTALL_TIMEOUT_MS = 240_000;

/**
 * Run `npm install` in `projectDir`. `omitDev=false` so typescript/@types are
 * present for `tsc --noEmit`. Returns `{ok:false}` (does NOT throw) on a
 * network/registry failure so the caller can skip.
 */
export async function npmInstall(projectDir: string): Promise<ProvisionResult> {
  try {
    await execFile('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: projectDir,
      timeout: INSTALL_TIMEOUT_MS,
      env: childEnv(),
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `npm install failed: ${(err as Error).message}` };
  }
}

/** `npm run build` (tsc) in a project that already has deps. Throws on failure (build errors are real bugs). */
export async function npmRunBuild(projectDir: string): Promise<{ stdout: string; stderr: string }> {
  return execFile('npm', ['run', 'build'], {
    cwd: projectDir,
    timeout: 120_000,
    env: childEnv(),
    maxBuffer: 32 * 1024 * 1024,
  });
}

export interface TscResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `npx tsc --noEmit` in a project. Unlike build, we return the exit code
 * instead of throwing, so the test can assert `code === 0` and attach the
 * compiler diagnostics to the failure message — a non-zero exit here is a
 * generated-code bug, not an environment problem.
 */
export async function tscNoEmit(projectDir: string): Promise<TscResult> {
  try {
    const { stdout, stderr } = await execFile('npx', ['tsc', '--noEmit'], {
      cwd: projectDir,
      timeout: 120_000,
      env: childEnv(),
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

// ── Python ────────────────────────────────────────────────────────────────

export interface PythonEnv {
  /** Absolute path to the venv's python interpreter, or null if unavailable. */
  python: string | null;
  /** Why python provisioning was skipped (only set when python === null). */
  reason?: string;
}

/**
 * Create a venv and `pip install` the generated server's runtime deps once.
 * Returns `{python:null, reason}` (never throws) when python3 / venv / pip /
 * network is unavailable so the python tests skip cleanly. The deps mirror the
 * generated `requirements.txt` (`mcp`, `pydantic`, `httpx`, `python-dotenv`).
 */
export async function provisionPythonVenv(parentDir: string): Promise<PythonEnv> {
  const venvDir = join(parentDir, '.venv');
  mkdirSync(parentDir, { recursive: true });
  // 1. Create the venv.
  try {
    await execFile('python3', ['-m', 'venv', venvDir], {
      timeout: 120_000,
      env: childEnv(),
    });
  } catch (err) {
    return { python: null, reason: `python3 -m venv failed: ${(err as Error).message}` };
  }
  const python = join(venvDir, 'bin', 'python');
  if (!existsSync(python)) {
    return { python: null, reason: `venv interpreter not found at ${python}` };
  }
  // 2. Install the runtime deps the generated server imports.
  try {
    await execFile(
      python,
      [
        '-m',
        'pip',
        'install',
        '--quiet',
        '--disable-pip-version-check',
        'mcp',
        'pydantic',
        'httpx',
        'python-dotenv',
      ],
      { timeout: INSTALL_TIMEOUT_MS, env: childEnv(), maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    return {
      python: null,
      reason: `pip install (mcp/pydantic/httpx/dotenv) failed: ${(err as Error).message}`,
    };
  }
  // 3. Sanity: the imports the generated server makes at module load must resolve.
  try {
    await execFile(
      python,
      ['-c', 'from mcp.server.fastmcp import FastMCP; import pydantic, httpx, dotenv'],
      {
        timeout: 30_000,
        env: childEnv(),
      },
    );
  } catch (err) {
    return {
      python: null,
      reason: `python deps imported but FastMCP missing: ${(err as Error).message}`,
    };
  }
  return { python };
}

/**
 * `python -c "import server"` with cwd at the project so `server.py` resolves as
 * the `server` module. Returns the exit code + output: exit 0 means the module
 * imported (catches the R17-C `AttributeError`/`SyntaxError` dead-on-import
 * class); non-zero with a traceback is a generated-code bug.
 */
export async function pythonImportServer(
  python: string,
  projectDir: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile(python, ['-c', 'import server'], {
      cwd: projectDir,
      timeout: 60_000,
      env: childEnv(),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}
