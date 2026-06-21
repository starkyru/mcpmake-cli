import { writeFile, rename, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';

export interface ScheduleEntry {
  slug: string;
  cronExpr: string;
  partial: boolean;
  nextRunAt: Date;
  createdAt: Date;
}

export type RescanCallback = (slug: string, partial: boolean) => void | Promise<void>;

/** Options for {@link RescanScheduler}. */
export interface RescanSchedulerOptions {
  /**
   * Optional path to a JSON file used to persist registered schedules so they
   * survive a process restart. When omitted, the scheduler is purely in-memory
   * (no disk I/O) and behaves exactly as it did before persistence existed.
   */
  persistPath?: string;
}

/** On-disk shape of a single persisted schedule (Dates serialized as ISO strings). */
interface PersistedEntry {
  slug: string;
  cronExpr: string;
  partial: boolean;
  nextRunAt: string;
  createdAt: string;
}

/** Suffix for the temp file used to write the persistence file atomically. */
const PERSIST_TEMP_SUFFIX = '.mcpmake-tmp';

/**
 * Scheduler for periodic site rescans.
 * Checks every 60 seconds for due rescans and invokes the callback.
 *
 * Schedules live in memory by default. Pass a `persistPath` to opt into
 * best-effort, file-based persistence so registered schedules survive a process
 * restart (see {@link load}).
 */
export class RescanScheduler {
  private schedules = new Map<string, ScheduleEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private callback: RescanCallback;
  private running = false;
  private ticking = false;
  private readonly persistPath: string | undefined;
  // Serializes persistence writes: every schedulePersist() appends to this
  // chain so two rapid scheduleRescan/cancelRescan calls can never race on the
  // shared file (interleaved writeFile+rename to one temp path would otherwise
  // lose data or leave the target missing mid-rename). Last write wins.
  private persistChain: Promise<void> = Promise.resolve();
  private persistSeq = 0;

  constructor(callback: RescanCallback, options: RescanSchedulerOptions = {}) {
    this.callback = callback;
    this.persistPath = options.persistPath;
  }

  /** Register or update a rescan schedule for a site slug. */
  scheduleRescan(slug: string, cronExpr: string, partial = false): void {
    const nextRunAt = computeNextRun(cronExpr, new Date());
    if (!nextRunAt) {
      logger.warn(`Invalid cron expression for slug "${slug}": ${cronExpr}`);
      return;
    }
    this.schedules.set(slug, {
      slug,
      cronExpr,
      partial,
      nextRunAt,
      createdAt: new Date(),
    });
    logger.info(`Scheduled rescan for "${slug}" — next run at ${nextRunAt.toISOString()}`);
    this.schedulePersist();
  }

  /** Cancel a pending rescan schedule. */
  cancelRescan(slug: string): boolean {
    const deleted = this.schedules.delete(slug);
    if (deleted) {
      logger.info(`Cancelled rescan schedule for "${slug}"`);
      this.schedulePersist();
    }
    return deleted;
  }

  /** Start the periodic checker (every 60s). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, 60_000);
    this.timer.unref?.();
    logger.info('Rescan scheduler started');
  }

  /** Stop the periodic checker. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Rescan scheduler stopped');
  }

  /** Visible for testing: run a single check cycle. */
  async tick(): Promise<void> {
    // Skip if a prior tick is still running: a crawl callback can take minutes,
    // far longer than the 60s interval, and overlapping ticks would double-run a
    // due slug and race on the `schedules` map.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      let mutated = false;
      for (const entry of this.schedules.values()) {
        if (entry.nextRunAt <= now) {
          try {
            await this.callback(entry.slug, entry.partial);
          } catch (err) {
            logger.error(
              `Rescan callback failed for "${entry.slug}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          // Advance to the next scheduled run
          const next = computeNextRun(entry.cronExpr, now);
          if (next) {
            entry.nextRunAt = next;
          } else {
            // Invalid cron — remove the schedule
            this.schedules.delete(entry.slug);
          }
          mutated = true;
        }
      }
      // Persist once per tick, only if the map actually changed (advanced a
      // nextRunAt or dropped an invalid cron), so the on-disk file stays in sync.
      if (mutated) {
        this.schedulePersist();
        await this.persistChain;
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Await all pending persistence writes — a durable checkpoint. Resolves
   * immediately when persistence is off. Callers (and tests) can await this to
   * be sure a prior `scheduleRescan`/`cancelRescan` has hit disk.
   */
  async flush(): Promise<void> {
    await this.persistChain;
  }

  /** Get all registered schedules (for introspection / testing). */
  getSchedules(): ReadonlyMap<string, ScheduleEntry> {
    return this.schedules;
  }

  /**
   * Repopulate schedules from `persistPath` (no-op when persistence is off).
   *
   * Missing file, malformed JSON, and individual bad entries are tolerated:
   * such cases are skipped with a warning and never throw, so a corrupt or
   * absent file leaves the scheduler empty rather than crashing startup. A
   * persisted `nextRunAt` that is already in the past is recomputed from the
   * cron expression against "now", so a schedule that came due during downtime
   * fires promptly on the next tick instead of being skipped or storming.
   */
  async load(): Promise<void> {
    if (!this.persistPath) return;

    let raw: string;
    try {
      raw = await readFile(this.persistPath, 'utf-8');
    } catch (err) {
      // Missing file is the normal first-run case — nothing to restore.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        logger.warn(
          `Could not read rescan schedule file "${this.persistPath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn(`Malformed rescan schedule file "${this.persistPath}" — ignoring`);
      return;
    }

    if (!Array.isArray(parsed)) {
      logger.warn(
        `Unexpected rescan schedule file shape in "${this.persistPath}" (expected an array) — ignoring`,
      );
      return;
    }

    const now = new Date();
    for (const item of parsed) {
      const entry = parsePersistedEntry(item, now);
      if (entry) {
        this.schedules.set(entry.slug, entry);
      } else {
        logger.warn(`Skipping malformed schedule entry in "${this.persistPath}"`);
      }
    }
  }

  /**
   * Queue a persistence write, serialized after any in-flight write. Returns
   * void (fire-and-forget for callers); await {@link flush} for durability.
   * Serialization is what makes back-to-back schedule/cancel calls safe: each
   * write runs to completion before the next starts, so they can't interleave
   * on the shared file.
   */
  private schedulePersist(): void {
    // Snapshot the schedules NOW so the queued write reflects the state at call
    // time even if later writes mutate the map further (each persistNow re-reads
    // the live map, but ordering guarantees the final write reflects final state).
    this.persistChain = this.persistChain.then(() => this.persistNow());
  }

  /**
   * Best-effort, atomic write of the current schedules to `persistPath`.
   *
   * No-op when persistence is off. Writes to a UNIQUE sibling temp file then
   * renames over the target so a crash mid-write cannot corrupt the file and
   * concurrent-but-serialized writes never collide on one temp path. Any I/O
   * error is caught and warned — persistence failure must never crash the
   * scheduler (and must never reject the serialization chain).
   */
  private async persistNow(): Promise<void> {
    if (!this.persistPath) return;

    const payload: PersistedEntry[] = [...this.schedules.values()].map((e) => ({
      slug: e.slug,
      cronExpr: e.cronExpr,
      partial: e.partial,
      nextRunAt: e.nextRunAt.toISOString(),
      createdAt: e.createdAt.toISOString(),
    }));

    const tempPath = `${this.persistPath}.${this.persistSeq++}${PERSIST_TEMP_SUFFIX}`;
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
      await rename(tempPath, this.persistPath);
    } catch (err) {
      logger.warn(
        `Failed to persist rescan schedules to "${this.persistPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Validate one parsed JSON value as a {@link ScheduleEntry}, returning null for
 * any structurally invalid entry. A `nextRunAt` in the past (relative to `now`)
 * is recomputed from the cron so downtime-missed runs fire promptly; if the
 * persisted cron is itself invalid the entry is rejected.
 */
function parsePersistedEntry(value: unknown, now: Date): ScheduleEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;

  if (
    typeof v['slug'] !== 'string' ||
    typeof v['cronExpr'] !== 'string' ||
    typeof v['partial'] !== 'boolean' ||
    typeof v['nextRunAt'] !== 'string' ||
    typeof v['createdAt'] !== 'string'
  ) {
    return null;
  }

  const slug = v['slug'];
  const cronExpr = v['cronExpr'];
  const partial = v['partial'];

  const createdAt = new Date(v['createdAt']);
  if (isNaN(createdAt.getTime())) return null;

  let nextRunAt = new Date(v['nextRunAt']);
  if (isNaN(nextRunAt.getTime())) return null;

  // A run that came due during downtime would otherwise be either skipped or
  // (for "* * * * *"-style crons) replayed for every missed minute. Recompute
  // the next run from the cron so it fires once, promptly, going forward.
  if (nextRunAt <= now) {
    const recomputed = computeNextRun(cronExpr, now);
    if (!recomputed) return null; // persisted cron no longer parses — drop it
    nextRunAt = recomputed;
  }

  return { slug, cronExpr, partial, nextRunAt, createdAt };
}

// ─── Simple Cron Parsing ──────────────────────────────────────────

/**
 * Parse a simplified cron expression and compute the next run time after `after`.
 *
 * Supported format: "minute hour dayOfMonth month dayOfWeek"
 *   - Each field can be a number or '*'
 *   - Ranges (1-5), lists (1,3,5), and step values (*\/10) are supported for minute/hour
 *
 * Returns null if the expression is invalid.
 */
export function computeNextRun(cronExpr: string, after: Date): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minuteSpec = parts[0];
  const hourSpec = parts[1];
  const domSpec = parts[2];
  const monthSpec = parts[3];
  const dowSpec = parts[4];

  const minutes = expandField(minuteSpec, 0, 59);
  const hours = expandField(hourSpec, 0, 23);
  const doms = expandField(domSpec, 1, 31);
  const months = expandField(monthSpec, 1, 12);
  const dows = expandField(dowSpec, 0, 6);

  if (!minutes || !hours || !doms || !months || !dows) return null;

  // Standard cron day matching: when BOTH day-of-month and day-of-week are
  // restricted (neither is '*'), a day matches if EITHER matches (OR). If only
  // one is restricted, only that one applies.
  const domRestricted = domSpec !== '*';
  const dowRestricted = dowSpec !== '*';

  // Brute-force search over the next ~400 days to find the first matching time,
  // so monthly/yearly cron schedules (which may not recur within a week) fire.
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // Start from the next minute

  const limit = new Date(after.getTime() + 400 * 24 * 60 * 60 * 1000);

  while (candidate < limit) {
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const dom = candidate.getDate();
    const mon = candidate.getMonth() + 1; // JS months are 0-based
    const dow = candidate.getDay();

    let dayMatches: boolean;
    if (domRestricted && dowRestricted) {
      dayMatches = doms.includes(dom) || dows.includes(dow);
    } else if (domRestricted) {
      dayMatches = doms.includes(dom);
    } else if (dowRestricted) {
      dayMatches = dows.includes(dow);
    } else {
      dayMatches = true;
    }

    if (minutes.includes(m) && hours.includes(h) && months.includes(mon) && dayMatches) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

function expandField(spec: string, min: number, max: number): number[] | null {
  if (spec === '*') {
    return range(min, max);
  }

  // Step: */N
  const stepMatch = spec.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    if (step <= 0 || step > max) return null;
    const result: number[] = [];
    for (let i = min; i <= max; i += step) {
      result.push(i);
    }
    return result;
  }

  // List: 1,3,5
  if (spec.includes(',')) {
    const values = spec.split(',').map((s) => parseInt(s.trim(), 10));
    if (values.some((v) => isNaN(v) || v < min || v > max)) return null;
    return values;
  }

  // Range: 1-5
  const rangeMatch = spec.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (start < min || end > max || start > end) return null;
    return range(start, end);
  }

  // Single number
  const num = parseInt(spec, 10);
  if (isNaN(num) || num < min || num > max) return null;
  return [num];
}

function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i <= end; i++) {
    result.push(i);
  }
  return result;
}
