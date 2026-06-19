import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadHarFile } from '../../src/parser/har-loader.js';
import { filterHarEntries } from '../../src/parser/har-filter.js';
import { normalizeEntry } from '../../src/parser/har-normalizer.js';
import { clusterEntries } from '../../src/transformer/har-clusterer.js';
import { clustersToOperations } from '../../src/transformer/har-to-operations.js';
import { buildAllTools } from '../../src/transformer/tool-builder.js';
import { emitProject } from '../../src/emitter/index.js';
import { pathExists } from '../../src/utils/fs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

describe('integration: HAR pipeline', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(resolve(tmpdir(), 'mcpmake-har-test-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('generates a project from a HAR file', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries);
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);
    const { operations, baseUrl, detectedAuth } = clustersToOperations(clusters);
    const tools = buildAllTools(operations);

    expect(operations.length).toBeGreaterThan(0);
    expect(baseUrl).toBe('https://api.example.com');
    expect(detectedAuth.length).toBeGreaterThan(0);
    expect(detectedAuth[0].type).toBe('bearer');

    await emitProject(
      {
        serverName: 'test-har-server',
        transport: 'stdio' as const,
        serverVersion: '1.0.0',
        baseUrl,
        tools,
        authSchemes: [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN' }],
        envVars: [
          { name: 'BASE_URL', description: 'API base URL', required: true },
          { name: 'BEARER_TOKEN', description: 'Bearer token', required: true },
        ],
      },
      { outputDir, force: true, dryRun: false },
    );

    expect(await pathExists(resolve(outputDir, 'package.json'))).toBe(true);
    expect(await pathExists(resolve(outputDir, 'src/index.ts'))).toBe(true);
    expect(await pathExists(resolve(outputDir, 'src/tools/index.ts'))).toBe(true);

    // Check tool count matches cluster count
    const toolIndex = await readFile(resolve(outputDir, 'src/tools/index.ts'), 'utf-8');
    for (const tool of tools) {
      expect(toolIndex).toContain(tool.fileName);
    }
  });

  it('detects bearer auth from HAR headers', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries);
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);
    const { detectedAuth } = clustersToOperations(clusters);

    expect(detectedAuth.some((a) => a.type === 'bearer')).toBe(true);
    // Token value should be redacted
    expect(detectedAuth[0].exampleValue).toBe('[REDACTED]');
  });

  it('generates tools with correct HTTP methods', async () => {
    const har = await loadHarFile(resolve(FIXTURES, 'sample-api.har'));
    const filtered = filterHarEntries(har.log.entries);
    const normalized = filtered.map(normalizeEntry);
    const clusters = clusterEntries(normalized);
    const { operations } = clustersToOperations(clusters);

    const methods = operations.map((op) => op.method);
    expect(methods).toContain('get');
    expect(methods).toContain('post');
    expect(methods).toContain('delete');
  });
});
