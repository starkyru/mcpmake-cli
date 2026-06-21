import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNextRun, RescanScheduler } from '../../src/rescan/rescan-scheduler.js';

// All dates are constructed in UTC and compared against UTC getters so the
// suite is timezone-independent. computeNextRun uses local-time getters, but
// constructing `after` from a fixed instant keeps the relative math stable.

describe('computeNextRun — search horizon (M7)', () => {
  it('fires a monthly schedule (1st of month) more than a week out', () => {
    // 00:00 on the 2nd → next "1st of month at 00:00" is ~30 days away.
    const after = new Date(2026, 0, 2, 0, 0, 0); // Jan 2, 2026 local
    const next = computeNextRun('0 0 1 * *', after);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(1);
    expect(next!.getMonth()).toBe(1); // February (0-based)
    expect(next!.getHours()).toBe(0);
    expect(next!.getMinutes()).toBe(0);
  });

  it('fires a yearly schedule (specific month + day) far in the future', () => {
    // Dec 1 → next "Mar 15 at 03:00" is well beyond the old 7-day horizon.
    const after = new Date(2026, 11, 1, 0, 0, 0);
    const next = computeNextRun('0 3 15 3 *', after);
    expect(next).not.toBeNull();
    expect(next!.getMonth()).toBe(2); // March
    expect(next!.getDate()).toBe(15);
    expect(next!.getHours()).toBe(3);
  });

  it('still resolves a frequent schedule to the very next minute', () => {
    const after = new Date(2026, 5, 20, 10, 30, 0);
    const next = computeNextRun('* * * * *', after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBe(new Date(2026, 5, 20, 10, 31, 0).getTime());
  });
});

describe('computeNextRun — day-of-month vs day-of-week (M8)', () => {
  // 2026-06-20 is a Saturday (dow 6). 2026-06-21 is a Sunday (dow 0).
  const after = new Date(2026, 5, 20, 12, 0, 0); // Sat Jun 20 2026, noon local

  it('OR-combines when BOTH dom and dow are restricted', () => {
    // "00:00 on the 25th OR on Mondays". The 25th of June 2026 is a Thursday,
    // but Monday June 22 comes first → matches via the dow branch.
    const next = computeNextRun('0 0 25 * 1', after);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(22); // Mon Jun 22 (dow match wins by being sooner)
    expect(next!.getDay()).toBe(1);

    // And a date that is the 25th but NOT a Monday must also match (dom branch).
    const afterAfterMon = new Date(2026, 5, 23, 0, 0, 0); // Tue Jun 23
    const next2 = computeNextRun('0 0 25 * 1', afterAfterMon);
    expect(next2).not.toBeNull();
    expect(next2!.getDate()).toBe(25); // Thu Jun 25 via dom, before next Monday (29th)
  });

  it('applies ONLY day-of-month when dow is "*"', () => {
    // "00:00 on the 21st" regardless of weekday.
    const next = computeNextRun('0 0 21 * *', after);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(21);
    expect(next!.getMonth()).toBe(5); // still June
  });

  it('applies ONLY day-of-week when dom is "*"', () => {
    // "00:00 on Sundays" (dow 0). Next Sunday after Sat Jun 20 is Jun 21.
    const next = computeNextRun('0 0 * * 0', after);
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(0);
    expect(next!.getDate()).toBe(21);
  });

  it('does NOT AND-combine: a 25th-and-Monday entry must not require both', () => {
    // Regression for the old AND bug: with AND semantics the next match would be
    // the first 25th that is also a Monday (months away). With correct OR it is
    // the next Monday OR the next 25th, whichever is first.
    const next = computeNextRun('0 0 25 * 1', after);
    expect(next).not.toBeNull();
    // Whatever it is, it must be within the current month — not months out.
    expect(next!.getMonth()).toBe(5);
  });

  it('matches every day when both dom and dow are "*"', () => {
    const next = computeNextRun('30 9 * * *', after);
    expect(next).not.toBeNull();
    // After Sat noon, next 09:30 is the following day (Jun 21).
    expect(next!.getDate()).toBe(21);
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(30);
  });
});

describe('RescanScheduler — interval unref (R2-B)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls unref() on the interval so the timer does not keep the process alive', () => {
    const unref = vi.fn();
    // Replace setInterval with a fake that returns an object exposing unref.
    const fakeTimer = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer);

    const scheduler = new RescanScheduler(() => {});
    scheduler.start();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();

    scheduler.stop();
  });
});

describe('RescanScheduler — opt-in persistence (L-sched)', () => {
  /** Run `fn` against a fresh temp dir, always cleaned up afterward. */
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'rescan-sched-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('defaults to pure in-memory: no persist path means no file is ever written', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'schedules.json');
      // No options object at all — preserves the original constructor signature.
      const scheduler = new RescanScheduler(() => {});
      scheduler.scheduleRescan('acme', '0 3 * * *');
      // Give any (incorrectly) fired async write a chance to land.
      await new Promise((r) => setTimeout(r, 20));
      await expect(readFile(persistPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(scheduler.getSchedules().get('acme')?.cronExpr).toBe('0 3 * * *');
    });
  });

  it('scheduleRescan writes the entry to persistPath as JSON with ISO dates', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'nested', 'schedules.json');
      const scheduler = new RescanScheduler(() => {}, { persistPath });
      scheduler.scheduleRescan('acme', '0 3 * * *', true);
      // Persistence is serialized + fire-and-forget; await the durable
      // checkpoint deterministically (no wall-clock polling race).
      await scheduler.flush();
      const onDisk = await readPersisted(persistPath);

      expect(onDisk).toHaveLength(1);
      const entry = onDisk[0];
      expect(entry.slug).toBe('acme');
      expect(entry.cronExpr).toBe('0 3 * * *');
      expect(entry.partial).toBe(true);
      // Dates are serialized as ISO strings (round-trippable, ends in Z).
      expect(typeof entry.nextRunAt).toBe('string');
      expect(new Date(entry.nextRunAt).toISOString()).toBe(entry.nextRunAt);
      expect(typeof entry.createdAt).toBe('string');
      expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt);
    });
  });

  it('load() on a new scheduler with the same persistPath restores the schedule', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'schedules.json');
      const writer = new RescanScheduler(() => {}, { persistPath });
      writer.scheduleRescan('acme', '0 3 * * *');
      writer.scheduleRescan('globex', '30 9 * * 1', true);
      await writer.flush(); // durable checkpoint — both serialized writes landed

      // Simulate a restart: a brand-new instance reads from disk.
      const restored = new RescanScheduler(() => {}, { persistPath });
      expect(restored.getSchedules().size).toBe(0); // nothing until load()
      await restored.load();

      const schedules = restored.getSchedules();
      expect(schedules.size).toBe(2);
      expect(schedules.get('acme')?.cronExpr).toBe('0 3 * * *');
      expect(schedules.get('acme')?.partial).toBe(false);
      expect(schedules.get('globex')?.cronExpr).toBe('30 9 * * 1');
      expect(schedules.get('globex')?.partial).toBe(true);
    });
  });

  it('load() recomputes a persisted past nextRunAt to a future run', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'schedules.json');
      // Hand-craft a file whose nextRunAt is firmly in the past so load() must
      // recompute it. cron "0 3 * * *" = daily at 03:00; independently derive
      // the expected next run via the REAL computeNextRun against "now".
      const past = new Date('2000-01-01T03:00:00.000Z').toISOString();
      await writeFile(
        persistPath,
        JSON.stringify([
          {
            slug: 'acme',
            cronExpr: '0 3 * * *',
            partial: false,
            nextRunAt: past,
            createdAt: past,
          },
        ]),
        'utf-8',
      );

      const before = new Date();
      const scheduler = new RescanScheduler(() => {}, { persistPath });
      await scheduler.load();
      const after = new Date();

      const entry = scheduler.getSchedules().get('acme');
      expect(entry).toBeDefined();
      // The stale past value must have been replaced with a future run...
      expect(entry!.nextRunAt.getTime()).toBeGreaterThan(after.getTime());
      // ...and it must equal what computeNextRun yields for the same window.
      const expectedLow = computeNextRun('0 3 * * *', before)!;
      const expectedHigh = computeNextRun('0 3 * * *', after)!;
      expect(entry!.nextRunAt.getTime()).toBeGreaterThanOrEqual(expectedLow.getTime());
      expect(entry!.nextRunAt.getTime()).toBeLessThanOrEqual(expectedHigh.getTime());
    });
  });

  it('load() keeps a future persisted nextRunAt verbatim (no needless recompute)', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'schedules.json');
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await writeFile(
        persistPath,
        JSON.stringify([
          {
            slug: 'acme',
            cronExpr: '0 3 * * *',
            partial: false,
            nextRunAt: future,
            createdAt: future,
          },
        ]),
        'utf-8',
      );

      const scheduler = new RescanScheduler(() => {}, { persistPath });
      await scheduler.load();

      expect(scheduler.getSchedules().get('acme')!.nextRunAt.toISOString()).toBe(future);
    });
  });

  it('load() on a malformed JSON file does not throw and yields an empty map', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'schedules.json');
      await writeFile(persistPath, '{ this is not valid json ]', 'utf-8');

      const scheduler = new RescanScheduler(() => {}, { persistPath });
      await expect(scheduler.load()).resolves.toBeUndefined();
      expect(scheduler.getSchedules().size).toBe(0);
    });
  });

  it('load() skips structurally-bad entries but keeps valid ones (partial restore)', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'schedules.json');
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await writeFile(
        persistPath,
        JSON.stringify([
          {
            slug: 'good',
            cronExpr: '0 3 * * *',
            partial: false,
            nextRunAt: future,
            createdAt: future,
          },
          { slug: 'missing-cron', partial: false, nextRunAt: future, createdAt: future }, // no cronExpr
          {
            slug: 'bad-date',
            cronExpr: '0 3 * * *',
            partial: false,
            nextRunAt: 'not-a-date',
            createdAt: future,
          },
          'totally-not-an-object',
        ]),
        'utf-8',
      );

      const scheduler = new RescanScheduler(() => {}, { persistPath });
      await scheduler.load();

      const schedules = scheduler.getSchedules();
      expect(schedules.size).toBe(1);
      expect(schedules.has('good')).toBe(true);
      expect(schedules.has('missing-cron')).toBe(false);
      expect(schedules.has('bad-date')).toBe(false);
    });
  });

  it('load() on a missing file is a no-op (empty map, no throw)', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'does-not-exist.json');
      const scheduler = new RescanScheduler(() => {}, { persistPath });
      await expect(scheduler.load()).resolves.toBeUndefined();
      expect(scheduler.getSchedules().size).toBe(0);
    });
  });

  it('cancelRescan updates the persisted file (removes the cancelled slug)', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'schedules.json');
      const scheduler = new RescanScheduler(() => {}, { persistPath });
      scheduler.scheduleRescan('acme', '0 3 * * *');
      scheduler.scheduleRescan('globex', '0 4 * * *');
      await scheduler.flush();
      let onDisk = await readPersisted(persistPath);
      expect(onDisk.map((e) => e.slug).sort()).toEqual(['acme', 'globex']);

      expect(scheduler.cancelRescan('acme')).toBe(true);
      await scheduler.flush(); // durable checkpoint — removal landed
      onDisk = await waitForPersisted(persistPath, (e) => e.length === 1);
      expect(onDisk.map((e) => e.slug)).toEqual(['globex']);
    });
  });

  it('cancelRescan for an unknown slug does not rewrite the file', async () => {
    await withTempDir(async (dir) => {
      const persistPath = join(dir, 'schedules.json');
      const scheduler = new RescanScheduler(() => {}, { persistPath });
      scheduler.scheduleRescan('acme', '0 3 * * *');
      await scheduler.flush();
      const before = await readFile(persistPath, 'utf-8');

      expect(scheduler.cancelRescan('nope')).toBe(false);
      await scheduler.flush();
      const after = await readFile(persistPath, 'utf-8');
      expect(after).toBe(before);
    });
  });
});

// ─── persistence test helpers ──────────────────────────────────────

interface OnDiskEntry {
  slug: string;
  cronExpr: string;
  partial: boolean;
  nextRunAt: string;
  createdAt: string;
}

/**
 * Poll the persist file (writes are fire-and-forget) until it parses as an
 * array, returning the parsed entries. Fails the surrounding test on timeout.
 */
async function readPersisted(path: string): Promise<OnDiskEntry[]> {
  return waitForPersisted(path, () => true);
}

/** Poll until the persisted array satisfies `pred`, or throw after ~1s. */
async function waitForPersisted(
  path: string,
  pred: (entries: OnDiskEntry[]) => boolean,
): Promise<OnDiskEntry[]> {
  const deadline = Date.now() + 1000;
  let last: OnDiskEntry[] | null = null;
  for (;;) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as OnDiskEntry[];
      last = parsed;
      if (Array.isArray(parsed) && pred(parsed)) return parsed;
    } catch {
      // file not written yet / mid-rename — retry
    }
    if (Date.now() > deadline) {
      throw new Error(
        `persist file ${path} did not reach expected state in time; last=${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
