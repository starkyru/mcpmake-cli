import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadHarFile } from '../../src/parser/har-loader.js';
import { filterHarEntries } from '../../src/parser/har-filter.js';
import { normalizeEntry } from '../../src/parser/har-normalizer.js';
import { clusterEntries } from '../../src/transformer/har-clusterer.js';
import { clustersToOperations } from '../../src/transformer/har-to-operations.js';
import { buildAllTools } from '../../src/transformer/tool-builder.js';
import { emitProject } from '../../src/emitter/index.js';
import { treeFingerprint } from '../../src/emitter/normalize-tree.js';
import type { CodeUnit } from '../../src/emitter/code-writer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

/** Read a generated project directory back into a CodeUnit[] (relative POSIX paths). */
async function readTree(dir: string): Promise<CodeUnit[]> {
  const out: CodeUnit[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const filePath = relative(dir, abs).split(sep).join('/');
        out.push({ filePath, content: await readFile(abs, 'utf-8') });
      }
    }
  }
  await walk(dir);
  return out;
}

describe('integration: emitter determinism gate', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await mkdtemp(resolve(tmpdir(), 'mcpmake-det-a-'));
    dirB = await mkdtemp(resolve(tmpdir(), 'mcpmake-det-b-'));
  });
  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('emits a byte-identical tree when the same manifest is generated twice', async () => {
    // Build a real manifest from the HAR fixture through the real pipeline (deterministic input).
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const { operations, baseUrl } = clustersToOperations(
      clusterEntries(filterHarEntries(har.log.entries).map(normalizeEntry)),
    );
    const tools = buildAllTools(operations);
    const manifest = {
      serverName: 'determinism-fixture',
      transport: 'stdio' as const,
      serverVersion: '1.0.0',
      baseUrl,
      tools,
      authSchemes: [{ type: 'http-bearer' as const, envVarName: 'BEARER_TOKEN' }],
      envVars: [{ name: 'BEARER_TOKEN', description: 'Bearer token', required: true }],
    };

    // Emit the SAME manifest to two independent directories.
    await emitProject(manifest, { outputDir: dirA, force: true, dryRun: false });
    await emitProject(manifest, { outputDir: dirB, force: true, dryRun: false });

    const treeA = await readTree(dirA);
    const treeB = await readTree(dirB);

    // The generator produced a non-trivial project (guards against a no-op false pass)...
    expect(treeA.length).toBeGreaterThan(5);
    expect(treeA.map((u) => u.filePath).sort()).toContain('src/index.ts');
    // ...and regenerating it is byte-identical — the property managed Sync depends on.
    expect(treeFingerprint(treeA)).toBe(treeFingerprint(treeB));

    // Both emits ran at the same instant, so a coarse (date/second-resolution) `new Date()`
    // leak would still fingerprint-match here and pass the assert above. Guard the leak class
    // directly: no generated file may carry an ISO-8601 datetime. A hardcoded license year like
    // "2026" is fine — it has no time component and won't match.
    const isoDateTime = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    for (const unit of treeA) {
      expect(
        isoDateTime.test(unit.content),
        `generated ${unit.filePath} contains a baked ISO timestamp (non-deterministic)`,
      ).toBe(false);
    }
  });
});
