import { weekday } from '../common/time';
import { carryForwardOf, leaveDays } from './leave-days';

const weekdays = (d: string) => ![0, 6].includes(weekday(d));

describe('leaveDays (§8.2)', () => {
  test('working days only, weekend skipped', () => {
    expect(leaveDays('2026-10-02', '2026-10-06', null, null, weekdays, false).total).toBe(3); // Fri, Mon, Tue
  });

  test('sandwich rule counts off days', () => {
    expect(leaveDays('2026-10-02', '2026-10-06', null, null, weekdays, true).total).toBe(5);
  });

  test('single half day', () => {
    expect(leaveDays('2026-10-05', '2026-10-05', 'FIRST', 'FIRST', weekdays, false).total).toBe(0.5);
  });

  test('halves at both ends', () => {
    expect(leaveDays('2026-10-05', '2026-10-07', 'SECOND', 'FIRST', weekdays, false).total).toBe(2);
  });

  test('leave spanning 31 March is split across leave years', () => {
    const r = leaveDays('2027-03-30', '2027-04-02', null, null, weekdays, false);
    expect(r.total).toBe(4);
    expect(r.byYear.get(2026)).toBe(2); // 30, 31 Mar 2027 belong to leave year 2026
    expect(r.byYear.get(2027)).toBe(2);
  });

  test('a range of only off days is zero', () => {
    expect(leaveDays('2026-10-03', '2026-10-04', null, null, weekdays, false).total).toBe(0);
  });
});

describe('carryForwardOf (§8.2)', () => {
  test('no cap carries everything', () => expect(carryForwardOf(7.5, null)).toEqual({ carried: 7.5, lapsed: 0 }));
  test('cap carries up to the cap, the rest lapses', () => expect(carryForwardOf(12, 5)).toEqual({ carried: 5, lapsed: 7 }));
  test('zero cap lapses everything', () => expect(carryForwardOf(3.5, 0)).toEqual({ carried: 0, lapsed: 3.5 }));
  test('nothing to carry from a non-positive balance', () => expect(carryForwardOf(-1, null)).toEqual({ carried: 0, lapsed: 0 }));
});
