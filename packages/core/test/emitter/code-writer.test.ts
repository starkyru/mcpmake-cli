import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { writeCodeUnits } from '../../src/emitter/code-writer.js';

describe('writeCodeUnits — atomic regeneration safety (M11/M12)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpmake-codewriter-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('force-writes all units and leaves no staging temp files behind (M11)', async () => {
    await writeCodeUnits(
      [
        { filePath: 'src/index.ts', content: 'export const a = 1;' },
        { filePath: 'src/tools/foo.ts', content: 'export const foo = 1;' },
      ],
      dir,
      { force: true, dryRun: false },
    );
    expect(await readFile(resolve(dir, 'src/index.ts'), 'utf-8')).toContain('a = 1');
    expect(await readFile(resolve(dir, 'src/tools/foo.ts'), 'utf-8')).toContain('foo = 1');
    // No leftover *.mcpmake-tmp anywhere.
    const tools = await readdir(resolve(dir, 'src/tools'));
    expect(tools.some((f) => f.includes('.mcpmake-tmp'))).toBe(false);
  });

  it('prune removes orphaned src/tools/*.ts no longer emitted (M12)', async () => {
    await mkdir(resolve(dir, 'src/tools'), { recursive: true });
    await writeFile(resolve(dir, 'src/tools/stale.ts'), 'export const stale = 1;');
    await writeFile(resolve(dir, 'src/tools/keep.ts'), 'old');

    await writeCodeUnits(
      [
        { filePath: 'src/tools/index.ts', content: '// index' },
        { filePath: 'src/tools/keep.ts', content: 'export const keep = 1;' },
      ],
      dir,
      { force: true, dryRun: false, prune: true },
    );

    const tools = await readdir(resolve(dir, 'src/tools'));
    expect(tools.sort()).toEqual(['index.ts', 'keep.ts']);
    // The re-emitted file was overwritten, not just left as-is.
    expect(await readFile(resolve(dir, 'src/tools/keep.ts'), 'utf-8')).toContain('keep = 1');
  });

  it('does not prune when prune is off (default) — fresh emits keep existing files', async () => {
    await mkdir(resolve(dir, 'src/tools'), { recursive: true });
    await writeFile(resolve(dir, 'src/tools/stale.ts'), 'export const stale = 1;');
    await writeCodeUnits([{ filePath: 'src/tools/index.ts', content: '// index' }], dir, {
      force: true,
      dryRun: false,
    });
    const tools = await readdir(resolve(dir, 'src/tools'));
    expect(tools).toContain('stale.ts');
  });

  it('prune never touches files outside src/tools', async () => {
    await mkdir(resolve(dir, 'src'), { recursive: true });
    await writeFile(resolve(dir, 'src/user-extra.ts'), 'export const mine = 1;');
    await writeCodeUnits([{ filePath: 'src/index.ts', content: '// index' }], dir, {
      force: true,
      dryRun: false,
      prune: true,
    });
    expect(await readFile(resolve(dir, 'src/user-extra.ts'), 'utf-8')).toContain('mine = 1');
  });

  it('rejects path traversal before writing anything', async () => {
    await expect(
      writeCodeUnits([{ filePath: '../escape.ts', content: 'x' }], dir, {
        force: true,
        dryRun: false,
      }),
    ).rejects.toThrow(/Path traversal/);
  });

  it('throws on a same-path/different-content duplicate before touching disk (data-loss guard)', async () => {
    await expect(
      writeCodeUnits(
        [
          { filePath: 'src/tools/home.ts', content: 'export const home = 1;' },
          { filePath: 'src/tools/home.ts', content: 'export const home = 2;' },
        ],
        dir,
        { force: true, dryRun: false },
      ),
    ).rejects.toThrow(/conflicting content/);
    // Nothing was written — the throw happens before any staging/rename.
    const top = await readdir(dir);
    expect(top).toEqual([]);
  });

  it('collapses an identical same-path duplicate without error', async () => {
    await writeCodeUnits(
      [
        { filePath: 'src/tools/home.ts', content: 'export const home = 1;' },
        { filePath: 'src/tools/home.ts', content: 'export const home = 1;' },
      ],
      dir,
      { force: true, dryRun: false },
    );
    expect(await readFile(resolve(dir, 'src/tools/home.ts'), 'utf-8')).toContain('home = 1');
  });

  it('dry-run writes nothing', async () => {
    await writeCodeUnits([{ filePath: 'src/index.ts', content: 'x' }], dir, {
      force: true,
      dryRun: true,
    });
    const top = await readdir(dir);
    expect(top).toEqual([]);
  });
});
