import { computeAttendanceDay, EngineDay, EngineInput, EnginePolicy, EnginePunch } from './compute-day';
import { punchWindow, resolveDay, RosterData, ShiftDef, shiftInstants, slotOf } from './schedule';

const TZ = 'Asia/Kolkata';
const D = '2026-10-05'; // a Monday

/** Local wall-clock on D (+dayOffset) in TZ. */
const t = (hm: string, dayOffset = 0) => {
  const date = new Date(`${D}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  const ymd = date.toISOString().slice(0, 10);
  const [h, m, s = '00'] = hm.split(':');
  return new Date(`${ymd}T${h}:${m}:${s}+05:30`);
};

const POLICY: EnginePolicy = {
  graceInMinutes: 10,
  graceOutMinutes: 10,
  halfDayMinPercent: 50,
  fullDayMinPercent: 90,
  duplicatePunchSeconds: 60,
  minSessionMinutes: 5,
  absentAfterMinutes: 120,
  missedOutCredit: 'NONE',
  overtimeEnabled: false,
  overtimeMinMinutes: 30,
  breakDeduction: 'SHIFT_BREAK',
  roundingMinutes: 0,
};

const GENERAL: ShiftDef = {
  id: 'gen',
  kind: 'FIXED',
  startTime: '09:00',
  endTime: '18:00',
  breakMinutes: 60,
  requiredMinutes: 480,
  worksHolidays: false,
};
const NIGHT: ShiftDef = { ...GENERAL, id: 'night', startTime: '22:00', endTime: '06:00' };
const MORNING: ShiftDef = { ...GENERAL, id: 'morning', startTime: '14:00', endTime: '22:00' };
const FLEX: ShiftDef = {
  ...GENERAL,
  id: 'flex',
  kind: 'FLEXIBLE',
  startTime: '07:00',
  endTime: '20:00',
  coreStart: '10:00',
  coreEnd: '16:00',
  requiredMinutes: 480,
  breakMinutes: 0,
};

function workingDay(shift: ShiftDef = GENERAL, date = D): EngineDay {
  const i = shiftInstants(date, shift, TZ);
  return {
    dayType: 'WORKING',
    flexible: shift.kind === 'FLEXIBLE',
    schedStart: i.schedStart,
    schedEnd: i.schedEnd,
    coreStart: i.coreStart,
    coreEnd: i.coreEnd,
    windowStart: new Date(i.schedStart.getTime() - 180 * 60_000),
    windowEnd: new Date(i.schedEnd.getTime() + 360 * 60_000),
    requiredMinutes: i.requiredMinutes,
    shiftBreakMinutes: shift.breakMinutes,
  };
}

const offDay = (dayType: 'HOLIDAY' | 'WEEKLY_OFF'): EngineDay => ({
  dayType,
  flexible: false,
  schedStart: null,
  schedEnd: null,
  coreStart: null,
  coreEnd: null,
  windowStart: t('04:00'),
  windowEnd: t('04:00', 1),
  requiredMinutes: 0,
  shiftBreakMinutes: 0,
});

const p = (hm: string, direction: EnginePunch['direction'], source = 'TERMINAL', dayOffset = 0): EnginePunch => ({
  at: t(hm, dayOffset),
  direction,
  source,
});

const AFTER = t('12:00', 2); // every window above has closed
const run = (over: Partial<EngineInput>) =>
  computeAttendanceDay({ day: workingDay(), punches: [], leave: null, remote: false, policy: POLICY, now: AFTER, ...over });

describe('computeAttendanceDay (§6.7)', () => {
  test.each([
    ['on-time', { punches: [p('09:00', 'in'), p('18:00', 'out')] }, { status: 'PRESENT', isLate: false, workedMinutes: 540 }],
    ['late within grace', { punches: [p('09:08', 'in'), p('18:00', 'out')] }, { status: 'PRESENT', isLate: false, lateMinutes: 0 }],
    ['late beyond grace', { punches: [p('09:25', 'in'), p('18:00', 'out')] }, { status: 'PRESENT', isLate: true, lateMinutes: 25 }],
    ['early exit', { punches: [p('09:00', 'in'), p('17:00', 'out')] }, { isEarlyExit: true, earlyExitMinutes: 60, workedMinutes: 480 }],
    ['no punch', { punches: [] }, { status: 'ABSENT', liveState: 'ABSENT', workedMinutes: 0 }],
    ['single punch (first-last)', { punches: [p('09:00', 'unknown')] }, { status: 'ABSENT', missedPunch: true, lastOut: null }],
    [
      'double-read within 60 s',
      { punches: [p('09:00:00', 'unknown'), p('09:00:30', 'unknown'), p('18:00', 'unknown')] },
      { punchCount: 2, workedMinutes: 480, breakMinutes: 60, status: 'PRESENT' },
    ],
    [
      'four consecutive outs',
      { punches: [p('09:00', 'in'), p('18:00', 'out'), p('18:01:10', 'out'), p('18:03', 'out'), p('18:05', 'out')] },
      { segments: [{ in: t('09:00').toISOString(), out: t('18:05').toISOString() }], lastOut: t('18:05') },
    ],
    [
      'night shift across midnight',
      { day: workingDay(NIGHT), punches: [p('21:55', 'in'), p('05:58', 'out', 'TERMINAL', 1)] },
      { status: 'PRESENT', workedMinutes: 483, isLate: false, isEarlyExit: false },
    ],
    [
      'flexible shift under core hours',
      { day: workingDay(FLEX), punches: [p('10:30', 'in'), p('15:00', 'out')] },
      { status: 'HALF_DAY', isLate: true, lateMinutes: 30, isEarlyExit: true, earlyExitMinutes: 60 },
    ],
    [
      'flexible shift, core covered',
      { day: workingDay(FLEX), punches: [p('08:00', 'in'), p('16:30', 'out')] },
      { status: 'PRESENT', isLate: false, isEarlyExit: false, workedMinutes: 510 },
    ],
    [
      'half-day leave morning + afternoon work',
      { leave: { portion: 0.5, half: 'FIRST', leaveTypeId: 'CL' }, punches: [p('13:30', 'in'), p('18:00', 'out')] },
      { status: 'HALF_LEAVE', isLate: false },
    ],
    [
      'half-day leave, remaining half not worked',
      { leave: { portion: 0.5, half: 'FIRST', leaveTypeId: 'CL' }, punches: [p('16:00', 'in'), p('18:00', 'out')] },
      { status: 'ABSENT' },
    ],
    [
      'full leave with a punch (conflict)',
      { leave: { portion: 1, half: null, leaveTypeId: 'CL' }, punches: [p('09:00', 'in')] },
      { status: 'ON_LEAVE', hasLeaveConflict: true, liveState: 'ON_LEAVE' },
    ],
    [
      'holiday worked',
      { day: offDay('HOLIDAY'), punches: [p('10:00', 'in'), p('14:00', 'out')] },
      { status: 'HOLIDAY', workedOnOffDay: true, overtimeMinutes: 240 },
    ],
    ['weekly off, no work', { day: offDay('WEEKLY_OFF') }, { status: 'WEEKLY_OFF', workedOnOffDay: false, liveState: 'OFF' }],
    [
      'remote day',
      { remote: true, punches: [p('09:00', 'in', 'MOBILE'), p('18:00', 'out', 'MOBILE')] },
      { status: 'REMOTE' },
    ],
    [
      'mixed day (in via IN gate, out via BOTH gate)',
      { punches: [p('09:00', 'in'), p('13:00', 'unknown'), p('14:00', 'unknown'), p('18:00', 'unknown')] },
      { status: 'PRESENT', workedMinutes: 480, breakMinutes: 60, lastOut: t('18:00') },
    ],
    ['entry-only gate with no out', { punches: [p('09:00', 'in')] }, { missedPunch: true, workedMinutes: 0, status: 'ABSENT' }],
    [
      'missed out, credit NONE',
      { punches: [p('09:00', 'in')], policy: { ...POLICY, missedOutCredit: 'NONE' } },
      { missedPunch: true, status: 'ABSENT' },
    ],
    [
      'missed out, credit UNTIL_SHIFT_END',
      { punches: [p('09:00', 'in')], policy: { ...POLICY, missedOutCredit: 'UNTIL_SHIFT_END' } },
      { missedPunch: true, workedMinutes: 540, status: 'PRESENT', lastOut: null, isEarlyExit: false },
    ],
    [
      'correction overriding a missing in',
      { punches: [p('09:00', 'in', 'CORRECTION'), p('18:00', 'out')] },
      { status: 'PRESENT', corrected: true },
    ],
    [
      'leading out is ignored',
      { punches: [p('08:00', 'out'), p('09:00', 'in'), p('18:00', 'out')] },
      { missedPunch: true, workedMinutes: 540, status: 'PRESENT' },
    ],
    [
      'overtime when enabled',
      { punches: [p('09:00', 'in'), p('20:00', 'out')], policy: { ...POLICY, overtimeEnabled: true } },
      { overtimeMinutes: 180 },
    ],
  ] as Array<[string, Partial<EngineInput>, Record<string, unknown>]>)('%s', (_name, input, expected) => {
    expect(run(input)).toMatchObject(expected);
  });

  describe('live state while the day is open', () => {
    test.each([
      ['09:05', [], 'NOT_YET_IN'],
      ['09:30', [], 'LATE_NOT_IN'],
      ['11:30', [], 'ABSENT'],
      ['10:00', [p('09:00', 'in')], 'IN'],
      ['10:00', [p('09:30', 'in')], 'IN_LATE'],
      ['13:30', [p('09:00', 'in'), p('13:00', 'out')], 'ON_BREAK'],
      ['18:30', [p('09:00', 'in'), p('18:00', 'out')], 'LEFT'],
    ] as Array<[string, EnginePunch[], string]>)('at %s → %s', (now, punches, liveState) => {
      const r = run({ punches, now: t(now) });
      expect(r.status).toBe('PENDING');
      expect(r.liveState).toBe(liveState);
    });

    test('worked so far counts the open segment', () => {
      expect(run({ punches: [p('09:00', 'in')], now: t('11:00') }).workedMinutes).toBe(120);
    });
  });
});

describe('schedule resolution and punch windows (§6.3, §7)', () => {
  const roster = (over: Partial<RosterData> = {}): RosterData => ({
    shifts: new Map([GENERAL, NIGHT, MORNING].map((s) => [s.id, s])),
    patterns: new Map([['rot', { id: 'rot', cycleDays: 6, days: ['morning', 'morning', 'night', 'night', null, null] }]]),
    schedules: [{ effectiveFrom: '2026-01-01', effectiveTo: null, shiftId: 'gen', weeklyOffs: [0] }],
    overrides: new Map(),
    holidays: new Map(),
    ...over,
  });

  test('fixed shift, weekly off on Sunday', () => {
    expect(resolveDay(roster(), '2026-10-05').dayType).toBe('WORKING');
    expect(resolveDay(roster(), '2026-10-04').dayType).toBe('WEEKLY_OFF');
  });

  test('override beats holiday beats schedule', () => {
    const r = roster({ holidays: new Map([['2026-10-02', 'Gandhi Jayanti']]) });
    expect(resolveDay(r, '2026-10-02')).toMatchObject({ dayType: 'HOLIDAY', holidayName: 'Gandhi Jayanti' });
    r.overrides.set('2026-10-02', 'night');
    expect(resolveDay(r, '2026-10-02')).toMatchObject({ dayType: 'WORKING', shift: { id: 'night' } });
    r.overrides.set('2026-10-05', null);
    expect(resolveDay(r, '2026-10-05').dayType).toBe('WEEKLY_OFF');
  });

  test('rotation pattern, including dates before the anchor', () => {
    const r = roster({ schedules: [{ effectiveFrom: '2026-01-01', effectiveTo: null, patternId: 'rot', anchorDate: '2026-10-01', weeklyOffs: [] }] });
    expect(resolveDay(r, '2026-10-01').shift?.id).toBe('morning');
    expect(resolveDay(r, '2026-10-03').shift?.id).toBe('night');
    expect(resolveDay(r, '2026-10-05').dayType).toBe('WEEKLY_OFF');
    expect(resolveDay(r, '2026-09-30').dayType).toBe('WEEKLY_OFF'); // index 5
    expect(resolveDay(r, '2026-09-28').shift?.id).toBe('night'); // index 3
  });

  const windowOf = (r: RosterData, date: string) => {
    const day = (d: string) => slotOf(resolveDay(r, d), TZ);
    const shift = (n: number) => {
      const x = new Date(`${date}T00:00:00Z`);
      x.setUTCDate(x.getUTCDate() + n);
      return x.toISOString().slice(0, 10);
    };
    return punchWindow(day(shift(-1)), day(shift(0)), day(shift(1)), { earlyWindowMinutes: 180, lateWindowMinutes: 360 }, TZ, '04:00');
  };
  const inside = (w: { windowStart: Date; windowEnd: Date }, at: Date) => w.windowStart <= at && at < w.windowEnd;

  test('night 22:00–06:00: 05:55 next morning belongs to D', () => {
    const r = roster({ schedules: [{ effectiveFrom: '2026-01-01', effectiveTo: null, shiftId: 'night', weeklyOffs: [] }] });
    expect(inside(windowOf(r, D), t('05:55', 1))).toBe(true);
    expect(inside(windowOf(r, '2026-10-06'), t('05:55', 1))).toBe(false);
  });

  test('day shift staying late: 01:30 next day belongs to D (overtime)', () => {
    expect(inside(windowOf(roster(), D), t('01:30', 1))).toBe(true);
  });

  test('rotation night D → morning D+1: 06:10 belongs to D (split at 10:00)', () => {
    const r = roster({ overrides: new Map([[D, 'night'], ['2026-10-06', 'morning']]) });
    const w = windowOf(r, D);
    expect(inside(w, t('06:10', 1))).toBe(true);
    expect(w.windowEnd).toEqual(t('10:00', 1));
    expect(inside(windowOf(r, '2026-10-06'), t('10:30', 1))).toBe(true);
  });

  test('off day walk-in belongs to the off day', () => {
    const w = windowOf(roster(), '2026-10-04'); // Sunday
    expect(inside(w, t('11:00', -1))).toBe(true);
  });

  test('every instant maps to exactly one work date across a week', () => {
    const r = roster({ overrides: new Map([['2026-10-06', 'night'], ['2026-10-07', 'morning']]) });
    const days = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    const windows = days.map((d) => windowOf(r, d));
    for (let i = 1; i < windows.length; i++) expect(windows[i].windowStart).toEqual(windows[i - 1].windowEnd);
  });

  test('DST spring-forward night shift is 7 h (Europe/London)', () => {
    const i = shiftInstants('2026-03-28', NIGHT, 'Europe/London');
    expect((i.schedEnd.getTime() - i.schedStart.getTime()) / 3_600_000).toBe(7);
    expect(i.requiredMinutes).toBe(7 * 60 - 60);
    const autumn = shiftInstants('2026-10-24', NIGHT, 'Europe/London');
    expect((autumn.schedEnd.getTime() - autumn.schedStart.getTime()) / 3_600_000).toBe(9);
  });
});
