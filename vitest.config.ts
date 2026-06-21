import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Root vitest config for the workspace.
 *
 * Tests import `@mcpmake/core` (the CLI package's dependency) but we alias it to
 * the TypeScript source so `vitest run` works without a prior `npm run build`.
 * vitest resolves the `.js` import extensions in the source back to their `.ts`
 * files automatically.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@mcpmake/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The e2e tier (spawns the built bin) has its own config; never run it in
    // the fast unit tier.
    exclude: ['**/*.e2e.test.ts', '**/node_modules/**'],
    // Browser-recorder / website tests spin up Playwright; give them headroom.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
