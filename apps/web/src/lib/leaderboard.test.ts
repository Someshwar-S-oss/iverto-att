import { describe, expect, it } from 'vitest';
import { byRank, score, type MonthTotals } from './leaderboard';

const row = (counts: Record<string, number>, lateDays = 0, lateDeductionDays = 0): MonthTotals => ({
  employee: { id: 'e', fullName: 'E', employeeCode: 'E1', departmentId: null }, counts, lateDays, lateDeductionDays,
});

describe('score', () => {
  it('nets the late deduction out of attendance and ignores pending/off days', () => {
    const s = score([row({ PRESENT: 16, HALF_DAY: 2, ON_LEAVE: 2, PENDING: 9, WEEKLY_OFF: 8 }, 4, 1)], true);
    expect(s.working).toBe(20);
    expect(s.present).toBe(17);
    expect(s.attendancePct).toBe(80); // (17 − 1) / 20
    expect(s.latePct).toBeCloseTo(22.22, 1); // 4 / 18
  });

  it('leaves approved leave out unless configured to count it', () => {
    const r = row({ PRESENT: 8, ON_LEAVE: 1, HALF_LEAVE: 2, ABSENT: 1 });
    expect(score([r]).attendancePct).toBe(90); // (8 + 1) / (8 + 1 + 1)
    expect(score([r], true).attendancePct).toBe(75); // 9 / 12
  });

  it('aggregates a department and has no score without working days', () => {
    const s = score([row({ PRESENT: 10 }), row({ ABSENT: 10 })]);
    expect(s.attendancePct).toBe(50);
    expect(score([row({ WEEKLY_OFF: 4 })]).attendancePct).toBeNull();
  });

  it('ranks by attendance then punctuality', () => {
    const [a, b, c, d] = [row({ PRESENT: 10 }, 5), row({ PRESENT: 10 }, 1), row({ PRESENT: 5, ABSENT: 5 }), row({})].map((r) => score([r]));
    expect([a, b, c, d].sort(byRank)).toEqual([b, a, c, d]);
  });
});
