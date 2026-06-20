import { resolve, dirname } from 'node:path';
import { writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { ensureDir, writeFileSafe } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

export interface CodeUnit {
  filePath: string; // relative to output dir
  content: string;
}

/** Suffix for staged temp files written during an atomic (force) regeneration. */
const TEMP_SUFFIX = '.mcpmake-tmp';

export async function writeCodeUnits(
  units: CodeUnit[],
  outputDir: string,
  options: { force: boolean; dryRun: boolean; prune?: boolean },
): Promise<void> {
  const resolvedOutputDir = resolve(outputDir);

  // Resolve + traversal-guard every unit up front so a malicious relative path
  // can never escape the output dir, and so we fail before touching the disk.
  const planned = units.map((unit) => {
    const absPath = resolve(outputDir, unit.filePath);
    if (!absPath.startsWith(resolvedOutputDir + '/') && absPath !== resolvedOutputDir) {
      throw new Error(
        `Path traversal detected: ${unit.filePath} resolves outside output directory`,
      );
    }
    return { absPath, unit };
  });

  if (options.dryRun) {
    for (const { unit } of planned) {
      logger.info(`[dry-run] Would write: ${unit.filePath}`);
    }
    return;
  }

  // Non-force (fresh emit): preserve skip-existing semantics. Writing brand-new
  // files cannot corrupt an existing good project, so no staging is needed.
  if (!options.force) {
    for (const { absPath, unit } of planned) {
      const written = await writeFileSafe(absPath, unit.content, { force: false });
      if (written) {
        logger.info(`  ${unit.filePath}`);
      } else {
        logger.warn(`  Skipped (exists): ${unit.filePath}`);
      }
    }
    return;
  }

  // Force (in-place regeneration): write atomically (M11). A direct overwrite
  // loop leaves a half-written, corrupt project if it fails partway through.
  // Instead, stage every file to a sibling temp, then promote with rename — so a
  // failure during staging touches no real file, and the promote burst (atomic
  // per file) keeps the corruption window vanishingly small.
  const staged: { tempPath: string; absPath: string; filePath: string }[] = [];
  try {
    for (const { absPath, unit } of planned) {
      await ensureDir(dirname(absPath));
      const tempPath = absPath + TEMP_SUFFIX;
      await writeFile(tempPath, unit.content, 'utf-8');
      staged.push({ tempPath, absPath, filePath: unit.filePath });
    }
  } catch (err) {
    // Roll back: remove any temp files already staged. No real file was touched.
    await Promise.allSettled(staged.map((s) => unlink(s.tempPath)));
    throw err;
  }

  for (const s of staged) {
    await rename(s.tempPath, s.absPath);
    logger.info(`  ${s.filePath}`);
  }

  // M12: drop orphaned generated tool files no longer in the emitted set.
  if (options.prune) {
    await pruneOrphanTools(
      resolvedOutputDir,
      staged.map((s) => s.absPath),
    );
  }
}

/**
 * Remove `src/tools/*.ts` files that the latest emit did not write. Removed
 * forms/pages/operations otherwise leave stale tool files on disk: dropped from
 * `src/tools/index.ts` but still compiled by `tsc` (M12). Scoped strictly to the
 * generator-owned `src/tools/` directory and to `.ts` files, so it never touches
 * user code elsewhere in the project.
 */
async function pruneOrphanTools(resolvedOutputDir: string, keptAbsPaths: string[]): Promise<void> {
  const toolsDir = resolve(resolvedOutputDir, 'src/tools');
  let entries;
  try {
    entries = await readdir(toolsDir, { withFileTypes: true });
  } catch {
    return; // no src/tools dir — nothing to prune
  }
  const kept = new Set(keptAbsPaths);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const absPath = resolve(toolsDir, entry.name);
    if (!kept.has(absPath)) {
      await unlink(absPath);
      logger.info(`  Removed orphaned: src/tools/${entry.name}`);
    }
  }
}
