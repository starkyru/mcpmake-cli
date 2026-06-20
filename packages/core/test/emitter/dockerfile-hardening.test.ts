import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMITTER_DIR = resolve(__dirname, '../../src/emitter');

const NODE_DOCKERFILE = readFileSync(resolve(EMITTER_DIR, 'templates/dockerfile.hbs'), 'utf-8');
const SITE_DOCKERFILE = readFileSync(
  resolve(EMITTER_DIR, 'site-templates/dockerfile.hbs'),
  'utf-8',
);
const PYTHON_DOCKERFILE = readFileSync(
  resolve(EMITTER_DIR, 'python-templates/dockerfile.hbs'),
  'utf-8',
);

/**
 * H8 + M15: generated Dockerfiles must run dependency installs with
 * `--ignore-scripts` so a malicious (transitive) dependency's install lifecycle
 * hook cannot achieve install-time RCE as root in the build/runtime container.
 * The server's own compile is an explicit `npm run build` step, so it does not
 * rely on any install lifecycle script and is unaffected by --ignore-scripts.
 *
 * M15: the generator does NOT emit a package-lock.json, so the Dockerfiles must
 * use `npm install` (not `npm ci`, which aborts without a lockfile) and must not
 * `COPY` a lockfile that does not exist — otherwise the documented Docker build
 * path is broken before it starts.
 */
describe('H8+M15: generated Dockerfiles harden installs and do not assume a lockfile', () => {
  for (const [label, dockerfile] of [
    ['node template', NODE_DOCKERFILE],
    ['site template', SITE_DOCKERFILE],
  ] as const) {
    describe(label, () => {
      // Only inspect actual command lines (RUN/COPY), never comments — comments
      // legitimately mention `npm ci`/`package-lock.json` to explain the choice.
      const runLines = dockerfile.split('\n').filter((line) => /^RUN\s/.test(line));
      const copyLines = dockerfile.split('\n').filter((line) => /^COPY\s/.test(line));

      it('runs every npm install with --ignore-scripts', () => {
        const installLines = runLines.filter((line) => /\bnpm (install|ci)\b/.test(line));
        // Both stages (builder + runtime) install dependencies.
        expect(installLines.length).toBeGreaterThanOrEqual(2);
        for (const line of installLines) {
          expect(line).toContain('--ignore-scripts');
        }
      });

      it('uses `npm install`, not `npm ci`, since no lockfile is emitted (M15)', () => {
        expect(runLines.some((line) => /\bnpm ci\b/.test(line))).toBe(false);
        expect(runLines.some((line) => /\bnpm install\b/.test(line))).toBe(true);
      });

      it('does not COPY a package-lock.json that the generator never emits (M15)', () => {
        expect(copyLines.some((line) => line.includes('package-lock.json'))).toBe(false);
        // It still copies package.json before installing.
        const pkgCopyIdx = dockerfile.indexOf('COPY package.json');
        const firstInstallIdx = dockerfile.search(/RUN npm install\b/);
        expect(pkgCopyIdx).toBeGreaterThan(-1);
        expect(pkgCopyIdx).toBeLessThan(firstInstallIdx);
      });

      it('keeps the legit compile as an EXPLICIT build step (not an install hook)', () => {
        // --ignore-scripts only breaks the build if the server relied on a
        // prepare/postinstall hook to compile. It does not — there is an
        // explicit `RUN npm run build` in the builder stage.
        expect(dockerfile).toContain('RUN npm run build');
      });
    });
  }
});

/**
 * L-pydocker: the Python Dockerfile must NOT bake `.env.example` in as the
 * runtime `.env`, which would ship placeholder/sample secrets into the image.
 * Real config is supplied at run time via env vars / --env-file.
 */
describe('L-pydocker: Python Dockerfile does not bake .env.example as runtime .env', () => {
  it('does not COPY .env.example to .env', () => {
    expect(PYTHON_DOCKERFILE).not.toMatch(/COPY\s+\.env\.example\s+\.env/);
  });
});
