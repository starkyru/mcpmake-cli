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

/**
 * The deterministic-generation GATE (TODO [cli] "Deterministic generation gate").
 *
 * `emit-determinism.test.ts` builds the manifest ONCE and emits it twice, so it only proves
 * the EMITTER is deterministic. This test runs the WHOLE pipeline — parse → transform → emit —
 * TWICE from the same fixture in clean directories, so transform-level non-determinism (cluster
 * / operation / tool ORDERING, Map/Set iteration, a baked timestamp or random id anywhere in
 * parse/transform/emit) would surface as a fingerprint mismatch. This is the property managed
 * Sync depends on: regenerating the same input yields byte-identical bytes, so the content hash
 * is stable and a re-sync produces no spurious diff / noise PR.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

async function readTree(dir: string): Promise<CodeUnit[]> {
  const out: CodeUnit[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile())
        out.push({ filePath: relative(dir, abs).split(sep).join('/'), content: await readFile(abs, 'utf-8') });
    }
  }
  await walk(dir);
  return out;
}

/** A FULL, independent generation run: parse the fixture → transform → emit into `dir`. */
async function generateInto(dir: string): Promise<void> {
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
  await emitProject(manifest, { outputDir: dir, force: true, dryRun: false });
}

describe('integration: full-pipeline determinism gate', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await mkdtemp(resolve(tmpdir(), 'mcpmake-pipe-a-'));
    dirB = await mkdtemp(resolve(tmpdir(), 'mcpmake-pipe-b-'));
  });
  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('parse→transform→emit twice from the same fixture is byte-identical', async () => {
    // Two INDEPENDENT full-pipeline runs (not one manifest emitted twice).
    await generateInto(dirA);
    await generateInto(dirB);

    const treeA = await readTree(dirA);
    const treeB = await readTree(dirB);

    // Non-trivial output (guards against a no-op false pass).
    expect(treeA.length).toBeGreaterThan(5);
    expect(treeA.map((u) => u.filePath)).toContain('src/index.ts');
    // The whole pipeline is deterministic — identical fingerprint AND identical per-file bytes.
    expect(treeFingerprint(treeA)).toBe(treeFingerprint(treeB));
    expect(treeB).toEqual(treeA);
  });

  it('no generated file bakes a wall-clock timestamp into its content', async () => {
    // A baked ISO timestamp / Date.now() would make two runs differ; assert directly too so
    // the cause is obvious if it ever regresses (not just a fingerprint mismatch).
    await generateInto(dirA);
    const tree = await readTree(dirA);
    const isoTimestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    for (const unit of tree) {
      expect(
        isoTimestamp.test(unit.content),
        `${unit.filePath} contains a wall-clock timestamp — non-deterministic generation`,
      ).toBe(false);
    }
  });
});
