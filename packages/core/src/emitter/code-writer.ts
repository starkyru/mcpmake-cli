import { resolve } from 'node:path';
import { writeFileSafe } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

export interface CodeUnit {
  filePath: string; // relative to output dir
  content: string;
}

export async function writeCodeUnits(
  units: CodeUnit[],
  outputDir: string,
  options: { force: boolean; dryRun: boolean },
): Promise<void> {
  const resolvedOutputDir = resolve(outputDir);
  for (const unit of units) {
    const absPath = resolve(outputDir, unit.filePath);
    if (!absPath.startsWith(resolvedOutputDir + '/') && absPath !== resolvedOutputDir) {
      throw new Error(
        `Path traversal detected: ${unit.filePath} resolves outside output directory`,
      );
    }
    if (options.dryRun) {
      logger.info(`[dry-run] Would write: ${unit.filePath}`);
      continue;
    }
    const written = await writeFileSafe(absPath, unit.content, {
      force: options.force,
    });
    if (written) {
      logger.info(`  ${unit.filePath}`);
    } else {
      logger.warn(`  Skipped (exists): ${unit.filePath}`);
    }
  }
}
