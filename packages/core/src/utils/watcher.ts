import { watch, type FSWatcher } from 'node:fs';
import { logger } from './logger.js';

export interface WatchOptions {
  filePath: string;
  onChange: () => Promise<void>;
  debounceMs?: number;
}

/**
 * Watch a file for changes and invoke a callback.
 * Debounces rapid successive changes (e.g., editor save + format).
 */
export function watchFile(options: WatchOptions): FSWatcher {
  const debounceMs = options.debounceMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const watcher = watch(options.filePath, (eventType) => {
    if (eventType !== 'change') return;
    if (running) return;

    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      running = true;
      logger.info('Spec file changed, regenerating...');
      try {
        await options.onChange();
        logger.success('Regeneration complete');
      } catch (err) {
        logger.error(`Regeneration failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        running = false;
      }
    }, debounceMs);
  });

  logger.info(`Watching for changes: ${options.filePath}`);
  logger.info('Press Ctrl+C to stop');

  return watcher;
}
