/**
 * Sprint E3 — `bundle` end-to-end (Tier-A, chained flow).
 *
 * The .mcpb bundler shells out to the system `zip`; verifying its output here
 * also needs `unzip`. Both are PRE-FLIGHTED below — if either is missing the
 * whole suite SKIPS with a clear message rather than failing spuriously on a
 * minimal box (Windows / bare Alpine).
 *
 * Flow: generate a real petstore project, synthesize a minimal dist/index.js
 * (we never run the project's own build — Sprint E3 uses --skip-build), then
 * `bundle --skip-build` and assert the produced .mcpb is a real zip with the
 * documented layout (manifest.json + server/dist/index.js) and a manifest that
 * carries every required field.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runCli, combined } from './helpers/run-cli.js';
import { ensureBuilt } from './helpers/build-guard.js';
import { withTempDir } from './helpers/sandbox.js';
import { E2E } from './helpers/gating.js';

const execFile = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE = resolve(__dirname, '..', 'fixtures', 'petstore.yaml');

/** Petstore name/version the manifest must echo from the generated package.json. */
const EXPECTED_NAME = 'swagger-petstore';
const EXPECTED_VERSION = '1.0.0';
/** The four petstore tool names the bundler extracts from src/tools/*.ts. */
const EXPECTED_TOOL_NAMES = ['list_pets', 'create_pet', 'show_pet_by_id', 'delete_pet'].sort();

/** Resolve true iff `bin -<flag>` runs (binary present on PATH). */
async function hasBinary(bin: string, flag: string): Promise<boolean> {
  try {
    await execFile(bin, [flag]);
    return true;
  } catch {
    return false;
  }
}

// Pre-flight: both `zip` (used by the bundler) and `unzip` (used by these
// assertions) must exist, else skip the entire suite with a clear reason.
const zipAvailable = await hasBinary('zip', '-v');
const unzipAvailable = await hasBinary('unzip', '-v');
const skipReason =
  !zipAvailable || !unzipAvailable
    ? `[skip] bundle e2e needs both \`zip\` (${zipAvailable ? 'ok' : 'MISSING'}) and ` +
      `\`unzip\` (${unzipAvailable ? 'ok' : 'MISSING'}) on PATH`
    : '';
if (skipReason) {
  // Surface the reason in test output so a CI skip is not silent.
  console.warn(skipReason);
}

/** Generate the canonical petstore project at `<sandbox>/proj`. */
async function generatePetstore(sandbox: string): Promise<string> {
  const projDir = resolve(sandbox, 'proj');
  const gen = await runCli(['from', 'openapi', PETSTORE, '-o', projDir], { cwd: sandbox });
  expect(gen.code, combined(gen)).toBe(0);
  return projDir;
}

/** `unzip -Z1 <archive>` → the archive's entry list (one path per line). */
async function listZip(archive: string): Promise<string[]> {
  const { stdout } = await execFile('unzip', ['-Z1', archive]);
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `unzip -p <archive> <member>` → the member's raw bytes as a string. */
async function readZipMember(archive: string, member: string): Promise<string> {
  const { stdout } = await execFile('unzip', ['-p', archive, member], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

describe.skipIf(!E2E || !!skipReason)('e2e bundle: .mcpb packaging of a generated project', () => {
  beforeAll(() => ensureBuilt());

  it('bundles a built project: exit 0 + a valid .mcpb zip with manifest + server/dist/index.js', async () => {
    await withTempDir(async (sandbox) => {
      const proj = await generatePetstore(sandbox);

      // Synthesize the build output the bundler requires (we do not run the
      // project's own `npm run build`; --skip-build trusts dist/ exists).
      await mkdir(resolve(proj, 'dist'), { recursive: true });
      await writeFile(resolve(proj, 'dist/index.js'), 'console.log("petstore mcp");\n', 'utf-8');

      const outPath = resolve(sandbox, 'petstore.mcpb');
      const r = await runCli(['bundle', proj, '-o', outPath, '--skip-build'], { cwd: sandbox });
      expect(r.code, combined(r)).toBe(0);
      expect(combined(r)).toContain(`MCPB bundle created: ${outPath}`);
      expect(existsSync(outPath)).toBe(true);

      // The archive must contain at least the manifest and the server entry point.
      const entries = await listZip(outPath);
      expect(entries).toContain('manifest.json');
      expect(entries).toContain('server/dist/index.js');
      // The stripped server package.json is also part of the documented layout.
      expect(entries).toContain('server/package.json');

      // manifest.json must parse and carry every required field.
      const manifest = JSON.parse(await readZipMember(outPath, 'manifest.json')) as {
        schema_version: string;
        name: string;
        version: string;
        tools: { name: string; description: string }[];
        env_vars: { name: string; description: string; required: boolean }[];
      };
      for (const key of ['schema_version', 'name', 'version', 'tools', 'env_vars'] as const) {
        expect(manifest, `manifest missing field: ${key}`).toHaveProperty(key);
      }
      expect(manifest.schema_version).toBe('1.0');
      expect(manifest.name).toBe(EXPECTED_NAME);
      expect(manifest.version).toBe(EXPECTED_VERSION);
      // Exactly the petstore's four tools were extracted from src/tools/*.ts.
      expect(manifest.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
      // env_vars is populated from .env.example (BASE_URL is always present).
      expect(manifest.env_vars.map((v) => v.name)).toContain('BASE_URL');
      expect(manifest.env_vars.every((v) => v.required === true)).toBe(true);
    });
  });

  it('exits 1 when the target dir has no package.json', async () => {
    await withTempDir(async (sandbox) => {
      const empty = resolve(sandbox, 'empty');
      await mkdir(empty, { recursive: true });

      const r = await runCli(['bundle', empty, '--skip-build'], { cwd: sandbox });
      expect(r.code).toBe(1);
      expect(combined(r)).toContain('Not a valid project directory (no package.json)');
    });
  });

  it('exits 1 with --skip-build when no dist/ exists', async () => {
    await withTempDir(async (sandbox) => {
      // A generated project, but we deliberately do NOT create dist/.
      const proj = await generatePetstore(sandbox);
      expect(existsSync(resolve(proj, 'dist'))).toBe(false);

      const r = await runCli(['bundle', proj, '--skip-build'], { cwd: sandbox });
      expect(r.code).toBe(1);
      const out = combined(r);
      expect(out).toContain('No dist/ directory found');
      expect(out).toContain('Bundle failed');
    });
  });
});
