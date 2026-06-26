/**
 * HTTP node entrypoint + dynamic discovery (emitted end-to-end).
 *
 * Regression: the HTTP server-main template unconditionally imported
 * `./tools/index.js` and never registered the discovery meta-tools, so
 * `--transport http --dynamic-discovery` (no static tools) emitted a project
 * that (a) imported a module the emitter never wrote (`src/tools/index.ts` is
 * only emitted when staticTools.length > 0 → TS2307) and (b) silently dropped
 * the entire dynamic-discovery feature. The stdio template handled both.
 *
 * Also locks the tsconfig fix that lets ANY dynamic-discovery server compile:
 * `discovery.ts` imports `./tool-catalog.json` with an import attribute, which
 * requires `resolveJsonModule` + a module mode that supports import attributes
 * (the old `Node16` rejected it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitProject } from '../../src/emitter/index.js';
import type { ProjectManifest } from '../../src/types/index.js';

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    serverName: 'demo',
    serverVersion: '1.0.0',
    baseUrl: 'https://api.example.com',
    transport: 'http',
    tools: [],
    authSchemes: [],
    envVars: [{ name: 'BASE_URL', description: 'base', required: false }],
    dynamicDiscovery: true,
    ...over,
  };
}

async function emitTo(over: Partial<ProjectManifest>): Promise<{
  dir: string;
  files: string[];
  read: (rel: string) => Promise<string>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'mcpmake-ddhttp-'));
  await emitProject(manifest(over), { outputDir: dir, force: true, dryRun: false });
  const walk = async (d: string, base = ''): Promise<string[]> => {
    const out: string[] = [];
    for (const ent of await readdir(join(dir, d), { withFileTypes: true })) {
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) out.push(...(await walk(join(d, ent.name), rel)));
      else out.push(rel);
    }
    return out;
  };
  return { dir, files: await walk(''), read: (rel) => readFile(join(dir, rel), 'utf-8') };
}

describe('emitProject — HTTP transport + pure dynamic discovery (no static tools)', () => {
  let ctx: Awaited<ReturnType<typeof emitTo>>;

  beforeAll(async () => {
    // No staticToolCount → hasStaticTools is false → src/tools/index.ts is never
    // emitted. This is the exact combination that produced a non-compiling server.
    ctx = await emitTo({});
  });
  afterAll(async () => {
    await rm(ctx.dir, { recursive: true, force: true });
  });

  it('does NOT emit src/tools/index.ts and DOES emit the discovery module', () => {
    expect(ctx.files).not.toContain('src/tools/index.ts');
    expect(ctx.files).toContain('src/discovery.ts');
    expect(ctx.files).toContain('src/tool-catalog.json');
  });

  it('entry imports discovery (not the un-emitted tools/index) and registers it', async () => {
    const index = await ctx.read('src/index.ts');
    expect(index).not.toContain("from './tools/index.js'");
    expect(index).not.toContain('registerAllTools');
    expect(index).toContain("import { registerDiscoveryTools } from './discovery.js'");
    expect(index).toContain('registerDiscoveryTools(server, config)');
  });

  it('emits a tsconfig that compiles the JSON-catalog import', async () => {
    // discovery.ts: `import catalog from './tool-catalog.json' with {type:'json'}`.
    const parsed = JSON.parse(await ctx.read('tsconfig.json'));
    expect(parsed.compilerOptions.resolveJsonModule).toBe(true);
    expect(parsed.compilerOptions.module).toBe('NodeNext');
    expect(parsed.compilerOptions.moduleResolution).toBe('NodeNext');
  });
});

describe('emitProject — HTTP transport + dynamic discovery WITH static tools (no regression)', () => {
  let ctx: Awaited<ReturnType<typeof emitTo>>;

  beforeAll(async () => {
    ctx = await emitTo({ staticToolCount: 3 });
  });
  afterAll(async () => {
    await rm(ctx.dir, { recursive: true, force: true });
  });

  it('keeps registerAllTools AND registers discovery when static tools exist', async () => {
    const index = await ctx.read('src/index.ts');
    expect(index).toContain("from './tools/index.js'");
    expect(index).toContain('registerAllTools(server, config)');
    expect(index).toContain('registerDiscoveryTools(server, config)');
  });
});
