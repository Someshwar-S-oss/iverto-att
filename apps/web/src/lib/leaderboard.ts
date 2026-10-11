/** One employee's month from /attendance/overview. */
export interface MonthTotals {
  employee: { id: string; fullName: string; employeeCode: string; departmentId: string | null };
  counts: Record<string, number>;
  lateDays: number;
  lateDeductionDays: number;
}

export interface Score {
  people: number;
  working: number;
  present: number;
  leave: number;
  absent: number;
  lateDays: number;
  deduction: number;
  /** (present − late deduction) / working days; null with no closed working days. */
  attendancePct: number | null;
  /** Late arrivals / days turned up. */
  latePct: number;
}

const n = (c: Record<string, number>, k: string) => c[k] ?? 0;

/**
 * Sums one or more employees into a score. Approved leave is left out of
 * working days unless `leaveCounts` (org setting); unapproved absences are
 * ABSENT and always count. Pending days (today, days ahead) are left out.
 */
export function score(rows: MonthTotals[], leaveCounts = false): Score {
  let working = 0, present = 0, leave = 0, absent = 0, turnedUp = 0, lateDays = 0, deduction = 0;
  for (const { counts: c, ...r } of rows) {
    working += n(c, 'PRESENT') + n(c, 'REMOTE') + n(c, 'HALF_DAY') + n(c, 'ABSENT')
      + (leaveCounts ? n(c, 'ON_LEAVE') + n(c, 'HALF_LEAVE') : n(c, 'HALF_LEAVE') / 2);
    present += n(c, 'PRESENT') + n(c, 'REMOTE') + (n(c, 'HALF_DAY') + n(c, 'HALF_LEAVE')) / 2;
    leave += n(c, 'ON_LEAVE') + n(c, 'HALF_LEAVE') / 2;
    absent += n(c, 'ABSENT') + n(c, 'HALF_DAY') / 2;
    turnedUp += n(c, 'PRESENT') + n(c, 'REMOTE') + n(c, 'HALF_DAY') + n(c, 'HALF_LEAVE');
    lateDays += r.lateDays;
    deduction += r.lateDeductionDays;
  }
  return {
    people: rows.length, working, present, leave, absent, lateDays, deduction,
    attendancePct: working ? (Math.max(0, present - deduction) / working) * 100 : null,
    // ponytail: today's late arrival counts before its day closes, so cap at 100.
    latePct: turnedUp ? Math.min(100, (lateDays / turnedUp) * 100) : 0,
  };
}

/** Best attendance first, then fewest late arrivals; no data sinks to the bottom. */
export const byRank = (a: Score, b: Score) => (b.attendancePct ?? -1) - (a.attendancePct ?? -1) || a.latePct - b.latePct;
