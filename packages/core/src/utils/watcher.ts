import { watch, type FSWatcher } from 'node:fs';
import { logger } from './logger.js';

export interface WatchOptions {
  filePath: string;
  onChange: () => Promise<void>;
  debounceMs?: number;
}

/**
 * Debounce + coalesce change notifications into regeneration runs.
 *
 * - Rapid bursts before a run are debounced into one run.
 * - A change that arrives *while* a run is in flight sets a single `pending`
 *   flag, so exactly one trailing run fires afterwards. The flag (not a queue)
 *   caps the backlog at one regardless of how many events land mid-run, which
 *   avoids an unbounded backlog / memory growth.
 *
 * Exposed (and exported) separately from the fs binding so the coalescing logic
 * is testable without relying on platform fs.watch event timing.
 */
export function createChangeHandler(
  onChange: () => Promise<void>,
  debounceMs: number,
): { notify: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;

  async function regenerate(): Promise<void> {
    running = true;
    try {
      do {
        pending = false;
        logger.info('Spec file changed, regenerating...');
        try {
          await onChange();
          logger.success('Regeneration complete');
        } catch (err) {
          logger.error(`Regeneration failed: ${err instanceof Error ? err.message : err}`);
        }
      } while (pending);
    } finally {
      running = false;
    }
  }

  return {
    notify() {
      if (running) {
        pending = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void regenerate();
      }, debounceMs);
    },
  };
}

/**
 * Watch a file for changes and invoke a callback.
 * Debounces rapid successive changes (e.g., editor save + format) and coalesces
 * changes that arrive during a regeneration into a single trailing run.
 */
export function watchFile(options: WatchOptions): FSWatcher {
  const debounceMs = options.debounceMs ?? 500;
  const handler = createChangeHandler(options.onChange, debounceMs);

  const watcher = watch(options.filePath, (eventType) => {
    if (eventType !== 'change') return;
    handler.notify();
  });

  logger.info(`Watching for changes: ${options.filePath}`);
  logger.info('Press Ctrl+C to stop');

  return watcher;
}
