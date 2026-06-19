import { readFile, stat } from 'node:fs/promises';
import type { Har } from 'har-format';

const MAX_HAR_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export async function loadHarFile(filePath: string): Promise<Har> {
  const fileInfo = await stat(filePath);
  if (fileInfo.size > MAX_HAR_SIZE_BYTES) {
    throw new Error(
      `HAR file is too large (${Math.round(fileInfo.size / 1024 / 1024)} MB). Maximum is 50 MB.`,
    );
  }

  const raw = await readFile(filePath, 'utf-8');
  const har: Har = JSON.parse(raw);

  if (!har.log?.entries || !Array.isArray(har.log.entries)) {
    throw new Error('Invalid HAR file: missing log.entries array');
  }

  return har;
}
