import { eachDay, leaveYearOf, Ymd } from '../common/time';

export type Half = 'FIRST' | 'SECOND';

/**
 * Leave-day arithmetic (§8.2), pure. `isWorking(date)` comes from the schedule
 * resolver; off days count only when the type counts them (sandwich rule).
 *
 * Halves: on a single day, `startHalf` is the half taken. Over several days,
 * `startHalf = SECOND` starts after lunch on the first day and `endHalf = FIRST`
 * ends at lunch on the last.
 *
 * Returns the total and the split per leave year (a request across 31 March
 * debits two years).
 */
export function leaveDays(
  from: Ymd,
  to: Ymd,
  startHalf: Half | null,
  endHalf: Half | null,
  isWorking: (date: Ymd) => boolean,
  countsOffDays: boolean,
): { total: number; byYear: Map<number, number>; perDay: Array<{ date: Ymd; portion: number }> } {
  const perDay: Array<{ date: Ymd; portion: number }> = [];
  for (const date of eachDay(from, to)) {
    if (!countsOffDays && !isWorking(date)) continue;
    let portion = 1;
    if (from === to) portion = startHalf ? 0.5 : 1;
    else if (date === from && startHalf === 'SECOND') portion = 0.5;
    else if (date === to && endHalf === 'FIRST') portion = 0.5;
    perDay.push({ date, portion });
  }
  const byYear = new Map<number, number>();
  for (const d of perDay) byYear.set(leaveYearOf(d.date), (byYear.get(leaveYearOf(d.date)) ?? 0) + d.portion);
  return { total: perDay.reduce((s, d) => s + d.portion, 0), byYear, perDay };
}

/** Year end (§8.2): how much of a positive closing balance moves to next year. `cap` null = no cap, 0 = nothing carries. */
export function carryForwardOf(balance: number, cap: number | null): { carried: number; lapsed: number } {
  if (balance <= 0) return { carried: 0, lapsed: 0 };
  const carried = cap === null ? balance : Math.min(balance, cap);
  return { carried, lapsed: Math.round((balance - carried) * 10) / 10 };
}
