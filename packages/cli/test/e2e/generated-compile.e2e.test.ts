/**
 * Sprint E6 Tier-A — the generated servers must COMPILE / IMPORT, not merely
 * have the right filenames on disk.
 *
 * The string-only tier (from-openapi.e2e.test.ts) proved the emitter writes the
 * expected tree, but a tree of files can still be a *dead* server: the python
 * target was once `AttributeError: 'Server' has no attribute 'tool'` at import,
 * and an arg-collision once produced a `SyntaxError` — both invisible to
 * filename/snapshot tests, both caught only by actually feeding the output to
 * its toolchain. This file does exactly that:
 *
 *   - node TS:        `npx tsc --noEmit` → exit 0   (after a one-time install)
 *   - cloudflare TS:  `npx tsc --noEmit` → exit 0   (never `wrangler deploy`)
 *   - python:         `python -c "import server"` → exit 0, across ≥2 specs incl.
 *                     a fixture whose params are literally named `body`/`url`/
 *                     `import` (the historical R17 collisions). `import server`
 *                     (NOT py_compile) is what catches a dead-on-import server:
 *                     py_compile only catches SyntaxError; the import executes
 *                     the `@server.tool` decorators and the FastMCP wiring.
 *
 * HEAVY: gated behind BOTH `MCPMAKE_E2E` and `MCPMAKE_E2E_HEAVY` because each
 * case touches the network (npm install / pip install) and the local toolchain.
 * If a one-time provision can't be done (offline, or python can't build `mcp`),
 * the affected case SKIPS with a console message instead of failing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { makeTempDir } from './helpers/sandbox.js';
import { E2E, E2E_HEAVY } from './helpers/gating.js';
import {
  npmInstall,
  tscNoEmit,
  provisionPythonVenv,
  pythonImportServer,
  type PythonEnv,
} from './helpers/provision.js';

const PETSTORE = fileURLToPath(new URL('../fixtures/petstore.yaml', import.meta.url));
/** Spec whose params are literally named body/url/import/headers/params/data → R17 collision zone. */
const COLLISION = fileURLToPath(new URL('./fixtures/collision.yaml', import.meta.url));

const HEAVY = E2E && E2E_HEAVY;

describe.skipIf(!HEAVY)('e2e Tier-A: generated servers compile / import', () => {
  beforeAll(() => ensureBuilt());

  // ── TypeScript: node target ──────────────────────────────────────────────
  describe('node TS target', () => {
    let projectDir: string;
    let provisioned: { ok: boolean; reason?: string } = { ok: false, reason: 'not run' };

    beforeAll(async () => {
      const dir = await makeTempDir();
      projectDir = join(dir, 'node-app');
      const gen = await runCli(['from', 'openapi', PETSTORE, '-o', projectDir], { cwd: dir });
      expect(gen.code, combined(gen)).toBe(0);
      provisioned = await npmInstall(projectDir);
      if (!provisioned.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[E6 Tier-A] SKIP node TS compile — provision failed: ${provisioned.reason}`);
      }
    }, 300_000);

    it('tsc --noEmit succeeds (generated TS is type-correct)', async () => {
      if (!provisioned.ok) return; // skip cleanly: install/network unavailable
      const r = await tscNoEmit(projectDir);
      // A non-zero exit here is a REAL generated-code bug — surface the diagnostics.
      expect(r.code, `tsc diagnostics:\n${r.stdout}\n${r.stderr}`).toBe(0);
    });
  });

  // ── TypeScript: cloudflare worker target ─────────────────────────────────
  describe('cloudflare worker TS target', () => {
    let projectDir: string;
    let provisioned: { ok: boolean; reason?: string } = { ok: false, reason: 'not run' };

    beforeAll(async () => {
      const dir = await makeTempDir();
      projectDir = join(dir, 'worker-app');
      const gen = await runCli(
        ['from', 'openapi', PETSTORE, '-o', projectDir, '--target', 'cloudflare'],
        { cwd: dir },
      );
      expect(gen.code, combined(gen)).toBe(0);
      provisioned = await npmInstall(projectDir);
      if (!provisioned.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `[E6 Tier-A] SKIP worker TS compile — provision failed: ${provisioned.reason}`,
        );
      }
    }, 300_000);

    it('tsc --noEmit succeeds for the Workers entry (no wrangler deploy)', async () => {
      if (!provisioned.ok) return;
      const r = await tscNoEmit(projectDir);
      expect(r.code, `tsc diagnostics:\n${r.stdout}\n${r.stderr}`).toBe(0);
    });
  });

  // ── Python target (≥2 specs, shared venv) ────────────────────────────────
  describe('python target', () => {
    let py: PythonEnv = { python: null, reason: 'not run' };
    const projects: Record<string, string> = {};

    beforeAll(async () => {
      const dir = await makeTempDir();
      // One venv shared by both specs.
      py = await provisionPythonVenv(dir);
      if (!py.python) {
        // eslint-disable-next-line no-console
        console.warn(`[E6 Tier-A] SKIP python import — provision failed: ${py.reason}`);
        return;
      }
      // Generate both specs as python servers.
      for (const [key, spec] of [
        ['petstore', PETSTORE],
        ['collision', COLLISION],
      ] as const) {
        const out = join(dir, `py-${key}`);
        const gen = await runCli(['from', 'openapi', spec, '-o', out, '--format', 'python'], {
          cwd: dir,
        });
        expect(gen.code, combined(gen)).toBe(0);
        projects[key] = out;
      }
    }, 300_000);

    it('petstore server imports (import server → exit 0)', async () => {
      if (!py.python) return;
      const r = await pythonImportServer(py.python, projects.petstore);
      // Exit 0 means the module body ran: @server.tool decorators applied, FastMCP
      // wired. A non-zero exit with a traceback is the R17 dead-on-import bug.
      expect(r.code, `python import traceback:\n${r.stderr}`).toBe(0);
    });

    it('collision spec (body/url/import params) imports without SyntaxError/AttributeError', async () => {
      if (!py.python) return;
      // Pre-check: the emitter must have de-collided the dangerous names in the
      // SOURCE before we even import — proves the fix is in place, not luck.
      const src = readFileSync(join(projects.collision, 'server.py'), 'utf8');
      // Request body keeps the canonical `body`; the param named `url`/`body`/`data`
      // are suffixed; the keyword operationId `import` is suffixed.
      expect(src).toMatch(/async def resolveUrl\(url_1: str, body: \w+, body_1:/);
      expect(src).toContain('async def import_(');
      expect(src).not.toMatch(/async def import\(/); // bare keyword would be a SyntaxError

      const r = await pythonImportServer(py.python, projects.collision);
      expect(r.code, `python import traceback:\n${r.stderr}`).toBe(0);
    });
  });
});
