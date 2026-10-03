import { describe, expect, it, vi } from 'vitest';

// The delta logic is pure; stub the modules that open a Supabase client and localStorage on import.
vi.mock('./api', () => ({ downloadExport: vi.fn(), queryClient: {} }));
vi.mock('./auth', () => ({ supabase: {} }));

import { applyDay, applyPunch, summarise, type Board, type Day, type Punch } from './live';

const day = (employeeId: string, liveState: string, extra: Partial<Day> = {}) =>
  ({ id: `d-${employeeId}`, employeeId, workDate: '2026-09-30', liveState, dayType: 'WORKING', isLate: false, ...extra }) as Day;

const board = (rows: Day[]): Board => ({ generatedAt: '', rows, devices: [], recentPunches: [], ...summarise(rows) });

describe('live board deltas', () => {
  it('replaces the employee row and recounts like the API snapshot', () => {
    const b = board([day('a', 'NOT_YET_IN'), day('b', 'IN')]);
    expect(b.summary).toMatchObject({ present: 1, notYetIn: 1, late: 0, scheduled: 2 });

    const next = applyDay(b, day('a', 'IN_LATE', { isLate: true }));
    expect(next.rows.map((r) => r.liveState)).toEqual(['IN_LATE', 'IN']);
    expect(next.summary).toMatchObject({ present: 2, notYetIn: 0, late: 1 });
    expect(next.counts.IN_LATE).toBe(1);
  });

  it('ignores employees outside this board and other work dates', () => {
    const b = board([day('a', 'IN')]);
    expect(applyDay(b, day('z', 'ABSENT'))).toBe(b);
    expect(applyDay(b, day('a', 'LEFT', { workDate: '2026-09-29' }))).toBe(b);
  });

  it('keeps the employee name when a delta arrives without it', () => {
    const b = board([day('a', 'IN', { employee: { id: 'a', fullName: 'Asha', employeeCode: 'E1', departmentId: null, siteId: 's' } })]);
    expect(applyDay(b, day('a', 'LEFT')).rows[0].employee?.fullName).toBe('Asha');
  });

  it('prepends punches once and caps the feed at 30', () => {
    let b = board([]);
    for (let i = 0; i < 35; i++) b = applyPunch(b, { id: `p${i}` } as Punch);
    b = applyPunch(b, { id: 'p34' } as Punch);
    expect(b.recentPunches).toHaveLength(30);
    expect(b.recentPunches[0].id).toBe('p34');
  });
});
