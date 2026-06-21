/**
 * E2E spawn harness — runs the *built* CLI binary as a real child process.
 *
 * Every existing unit test imports a command and calls `command.run!(ctx)`
 * in-process, which never exercises the `bin/mcpmake.mjs` shim, citty arg
 * parsing, the `from` router, real `process.exit` codes, or `.env` autoloading.
 * `runCli` closes that gap: it spawns `node bin/mcpmake.mjs <args>` with a
 * **scrubbed, allowlisted env** so a developer's real `ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY` / `MCPMAKE_DEPLOY_TOKEN` can never leak into a test, and no
 * test can accidentally hit a real provider or the real cloud backend.
 *
 * The env is built from an empty object (NOT a copy of `process.env`), so the
 * allowlist is positive: only `PATH` is inherited; everything else is set
 * explicitly here or by the caller via `opts.env`.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Absolute path to the published shim the user actually invokes. */
export const BIN_PATH = fileURLToPath(new URL('../../../bin/mcpmake.mjs', import.meta.url));

export interface RunCliOptions {
  /** Working directory for the child (defaults to a throwaway: the OS tmp root). */
  cwd?: string;
  /**
   * Extra env entries merged over the scrubbed base. Use this to point
   * `HOME`/`MCPMAKE_CONFIG_DIR` at a sandbox, or to inject `MCPMAKE_SERVER`,
   * `MCPMAKE_DEPLOY_TOKEN`, mock-LLM vars, etc. for a specific test.
   */
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin then closed (for prompts / piped specs). */
  input?: string;
  /** Hard wall-clock cap; on expiry the child is SIGKILLed and the call rejects. */
  timeoutMs?: number;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  /** Process exit code; `null` only if the process was signalled (we treat that as failure). */
  code: number | null;
  /** Signal that terminated the process, if any. */
  signal: NodeJS.Signals | null;
}

/** Default cap — generous enough for local generators, well under CI sprint timeouts. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Secrets that must NEVER reach a child even if exported in the dev/CI shell.
 * Because the base env starts empty these are excluded by construction; the
 * explicit list documents intent and guards a future refactor that might switch
 * to copying `process.env`.
 */
const NEVER_INHERIT = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'MCPMAKE_DEPLOY_TOKEN',
  'MCPMAKE_SERVER',
  'MCPMAKE_LLM_PROVIDER',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
] as const;

/**
 * Build the scrubbed env handed to the child. Positive allowlist: only `PATH`
 * is inherited from the parent; `HOME` and `MCPMAKE_CONFIG_DIR` default to
 * `cwd` (so credential writes land in the sandbox, never the real `~/.mcpmake`);
 * `CI=1` and `MCPMAKE_NO_UPSELL=1` keep output deterministic and net-free.
 */
function scrubbedEnv(cwd: string, overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: cwd,
    MCPMAKE_CONFIG_DIR: cwd,
    MCPMAKE_NO_UPSELL: '1',
    CI: '1',
  };
  for (const key of NEVER_INHERIT) delete base[key];
  const merged = { ...base, ...overrides };
  // A caller may pass `KEY: undefined` to explicitly unset a default.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Spawn the built CLI and resolve with its captured output and exit code.
 *
 * Never rejects on a non-zero exit (that is a normal assertable outcome); it
 * rejects only on spawn failure or timeout. On timeout the child is SIGKILLed.
 */
export function runCli(args: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  const cwd = opts.cwd ?? process.cwd();
  const env = scrubbedEnv(cwd, opts.env);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<RunCliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `runCli timed out after ${timeoutMs}ms: mcpmake ${args.join(' ')}\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    }, timeoutMs);
    // Don't let a pending timer keep the test runner's event loop alive.
    timer.unref?.();

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/** Strip ANSI SGR escapes so assertions match the human-visible text. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

/** Convenience: combined, ANSI-stripped output for substring assertions. */
export function combined(result: RunCliResult): string {
  return stripAnsi(result.stdout + result.stderr);
}
