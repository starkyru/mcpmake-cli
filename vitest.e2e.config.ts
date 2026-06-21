import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// E2E config: the true end-to-end tier. Unlike the fast unit config (which
// aliases @mcpmake/core to TypeScript source), this runs against the built
// dist/: the tests spawn the real bin/mcpmake.mjs, which imports dist/, so any
// helper that also imports @mcpmake/core must see the same compiled code the
// binary runs. A prior `npm run build` is required (see build-guard).
//
// Only *.e2e.test.ts under packages/[*]/test/e2e/ is collected here; the root
// config explicitly excludes these so they never run in the fast tier.
export default defineConfig({
  resolve: {
    alias: {
      '@mcpmake/core': fileURLToPath(new URL('./packages/core/dist/index.js', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/e2e/**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
