import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeFileSafe(
  filePath: string,
  content: string,
  options: { force: boolean },
): Promise<boolean> {
  if (!options.force) {
    try {
      await access(filePath);
      return false; // file exists, skip
    } catch {
      // file doesn't exist, proceed
    }
  }
  await ensureDir(dirname(filePath));
  await writeFile(filePath, content, 'utf-8');
  return true;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
