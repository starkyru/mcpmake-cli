import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdapterFromPath } from '../../src/plugins/loader.js';

// A minimal ESM adapter module the loader can dynamically import.
const ADAPTER_SOURCE = `export default {
  name: 'fixture-adapter',
  description: 'fixture',
  parse: async () => ({
    operations: [],
    baseUrl: '',
    authSchemes: [],
    envVars: [],
    info: { title: 'T', version: '1.0.0' },
  }),
};
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpmake-plugins-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadAdapterFromPath — specifier validation', () => {
  it('loads a local adapter that resolves inside the plugins dir', async () => {
    writeFileSync(join(dir, 'fixture.mjs'), ADAPTER_SOURCE);
    const adapter = await loadAdapterFromPath('./fixture.mjs', dir);
    expect(adapter.name).toBe('fixture-adapter');
  });

  it('rejects a path-traversal specifier that escapes the plugins dir', async () => {
    await expect(loadAdapterFromPath('../evil.mjs', dir)).rejects.toThrow(
      /outside the plugins directory/,
    );
  });

  it('rejects an absolute path outside the plugins dir', async () => {
    await expect(loadAdapterFromPath('/etc/passwd', dir)).rejects.toThrow(
      /outside the plugins directory/,
    );
  });

  it('refuses a local path when no plugins dir is configured', async () => {
    await expect(loadAdapterFromPath('./fixture.mjs')).rejects.toThrow(
      /no plugins directory is configured/,
    );
  });

  it('rejects a malformed npm package specifier', async () => {
    await expect(loadAdapterFromPath('not a package!')).rejects.toThrow(
      /not a valid npm package name/,
    );
  });

  it('accepts bare and scoped package names (resolution failure, not a validation reject)', async () => {
    // Validation passes, so the error is the import failure, not a reject message.
    await expect(loadAdapterFromPath('definitely-missing-pkg')).rejects.toThrow(
      /Failed to load adapter/,
    );
    await expect(loadAdapterFromPath('@scope/definitely-missing-pkg')).rejects.toThrow(
      /Failed to load adapter/,
    );
  });
});
