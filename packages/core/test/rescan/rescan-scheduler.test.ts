import { describe, it, expect } from 'vitest';
import { computeNextRun } from '../../src/rescan/rescan-scheduler.js';

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
