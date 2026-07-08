/**
 * Boot a generated Cloudflare Worker locally with `wrangler dev` for the parity
 * suite. The generated project pins wrangler as a devDependency, so a prior
 * `npm install` in the project dir provides the binary; `npx wrangler` resolves
 * it from the project's node_modules.
 *
 * Config: `.dev.vars` is written from `vars` — wrangler dev overlays it on the
 * wrangler.toml [vars] table, INCLUDING the baked BASE_URL (verified against
 * wrangler 3.x), so tests can point the worker at the mock upstream without
 * touching the generated toml.
 *
 * Mirrors the provision.ts skip-cleanly contract: a missing/failed wrangler
 * boot returns `{ok:false, reason}` instead of throwing, so an environment
 * problem (no toolchain, sandboxed network) skips the worker runtime rather
 * than failing the suite. `stop()` kills the whole process group — wrangler
 * spawns a workerd child that would otherwise outlive the test run.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface WranglerDevOptions {
  projectDir: string;
  /** Written to `.dev.vars` (overrides wrangler.toml [vars], incl. BASE_URL). */
  vars: Record<string, string>;
  bootTimeoutMs?: number;
}

export type WranglerDevHandle =
  | { ok: true; url: string; logs: () => string; stop: () => Promise<void> }
  | { ok: false; reason: string };

/** Ask the OS for a free port (listen on 0, read it back, close). */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kill a detached child's whole process group (SIGTERM, then SIGKILL). */
async function killProcessGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Group already gone.
  }
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5_000);
    t.unref?.();
    child.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
    if (child.exitCode !== null) {
      clearTimeout(t);
      resolve(true);
    }
  });
  if (!exited && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Group already gone.
    }
  }
}

/**
 * Write `.dev.vars`, spawn `npx wrangler dev` on a free port, and poll
 * `GET /health` (unauthenticated by design) until the worker answers.
 */
export async function startWranglerDev(opts: WranglerDevOptions): Promise<WranglerDevHandle> {
  const bootTimeoutMs = opts.bootTimeoutMs ?? 120_000;

  // .dev.vars: KEY=value lines. The parity values are simple (URLs/tokens), no
  // quoting needed; assert that so a future exotic value fails loudly.
  const lines = Object.entries(opts.vars).map(([k, v]) => {
    if (/[\r\n]/.test(v)) throw new Error(`.dev.vars value for ${k} must be single-line`);
    return `${k}=${v}`;
  });
  writeFileSync(join(opts.projectDir, '.dev.vars'), `${lines.join('\n')}\n`, 'utf8');

  let port: number;
  try {
    port = await getFreePort();
  } catch (err) {
    return { ok: false, reason: `could not allocate a port: ${(err as Error).message}` };
  }

  let output = '';
  let child: ChildProcess;
  try {
    // detached → its own process group, so stop() can kill wrangler AND the
    // workerd child it spawns. CI=1 suppresses interactive prompts.
    child = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], {
      cwd: opts.projectDir,
      detached: true,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { ok: false, reason: `failed to spawn wrangler: ${(err as Error).message}` };
  }
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => (output += c));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c: string) => (output += c));
  let exited = false;
  child.on('exit', () => (exited = true));
  child.on('error', () => (exited = true));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      return { ok: false, reason: `wrangler dev exited during boot:\n${output.slice(-2000)}` };
    }
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        return {
          ok: true,
          url,
          logs: () => output,
          stop: () => killProcessGroup(child),
        };
      }
    } catch {
      // Not up yet — keep polling.
    }
    await sleep(1_000);
  }
  await killProcessGroup(child);
  return {
    ok: false,
    reason: `wrangler dev did not become healthy within ${bootTimeoutMs}ms:\n${output.slice(-2000)}`,
  };
}
