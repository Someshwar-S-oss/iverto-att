/**
 * Pure schedule resolution and punch-window rules (§6.3, §7.1). No I/O.
 */
import { addDays, diffDays, weekday, Ymd, zonedInstant } from '../../common/time';

export interface ShiftDef {
  id: string;
  kind: 'FIXED' | 'FLEXIBLE';
  startTime: string; // HH:mm, site-local
  endTime: string;
  breakMinutes: number;
  requiredMinutes: number;
  coreStart?: string | null;
  coreEnd?: string | null;
  worksHolidays: boolean;
  policyId?: string | null;
}

export interface ScheduleDef {
  effectiveFrom: Ymd;
  effectiveTo: Ymd | null;
  shiftId?: string | null;
  weeklyOffs: number[];
  patternId?: string | null;
  anchorDate?: Ymd | null;
}

export interface PatternDef {
  id: string;
  cycleDays: number;
  days: (string | null)[];
}

export interface RosterData {
  shifts: Map<string, ShiftDef>;
  patterns: Map<string, PatternDef>;
  schedules: ScheduleDef[];
  /** date → shift id, or null for an explicit day off */
  overrides: Map<Ymd, string | null>;
  /** date → holiday name */
  holidays: Map<Ymd, string>;
}

export type DayType = 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY';

export interface ResolvedDay {
  date: Ymd;
  dayType: DayType;
  shift: ShiftDef | null;
  holidayName: string | null;
}

/** The shift the standing schedule gives on a date, ignoring holidays and overrides. */
function scheduledShift(roster: RosterData, date: Ymd): ShiftDef | null {
  const schedule = roster.schedules.find(
    (s) => s.effectiveFrom <= date && (s.effectiveTo === null || date <= s.effectiveTo),
  );
  if (!schedule) return null;
  if (schedule.patternId) {
    const pattern = roster.patterns.get(schedule.patternId);
    if (!pattern || !schedule.anchorDate || pattern.cycleDays < 1) return null;
    const offset = diffDays(schedule.anchorDate, date);
    const index = ((offset % pattern.cycleDays) + pattern.cycleDays) % pattern.cycleDays;
    const shiftId = pattern.days[index];
    return shiftId ? roster.shifts.get(shiftId) ?? null : null;
  }
  if (schedule.weeklyOffs.includes(weekday(date))) return null;
  return schedule.shiftId ? roster.shifts.get(schedule.shiftId) ?? null : null;
}

/** override → holiday (unless the shift works holidays) → schedule → none (off). */
export function resolveDay(roster: RosterData, date: Ymd): ResolvedDay {
  const holidayName = roster.holidays.get(date) ?? null;
  if (roster.overrides.has(date)) {
    const id = roster.overrides.get(date);
    const shift = id ? roster.shifts.get(id) ?? null : null;
    return { date, dayType: shift ? 'WORKING' : 'WEEKLY_OFF', shift, holidayName };
  }
  const shift = scheduledShift(roster, date);
  if (holidayName && !shift?.worksHolidays) return { date, dayType: 'HOLIDAY', shift: null, holidayName };
  return { date, dayType: shift ? 'WORKING' : 'WEEKLY_OFF', shift, holidayName };
}

export interface ScheduledInstants {
  schedStart: Date;
  schedEnd: Date;
  coreStart: Date | null;
  coreEnd: Date | null;
  requiredMinutes: number;
}

/** Wall-clock shift → instants on a date, per-day DST aware (§7.3). */
export function shiftInstants(date: Ymd, shift: ShiftDef, tz: string): ScheduledInstants {
  const overnight = shift.endTime <= shift.startTime;
  const schedStart = zonedInstant(date, shift.startTime, tz);
  const schedEnd = zonedInstant(overnight ? addDays(date, 1) : date, shift.endTime, tz);
  const at = (hm: string | null | undefined) => {
    if (!hm) return null;
    // Core times belong to the same shift occurrence: after start, possibly next day.
    return zonedInstant(hm < shift.startTime ? addDays(date, 1) : date, hm, tz);
  };
  const span = Math.round((schedEnd.getTime() - schedStart.getTime()) / 60_000);
  return {
    schedStart,
    schedEnd,
    coreStart: shift.kind === 'FLEXIBLE' ? at(shift.coreStart) : null,
    coreEnd: shift.kind === 'FLEXIBLE' ? at(shift.coreEnd) : null,
    // FIXED: measured between instants, so a DST night is genuinely 7 h or 9 h.
    requiredMinutes: shift.kind === 'FIXED' ? Math.max(0, span - shift.breakMinutes) : shift.requiredMinutes,
  };
}

export interface WindowPolicy {
  earlyWindowMinutes: number;
  lateWindowMinutes: number;
}

interface Slot {
  date: Ymd;
  working: boolean;
  schedStart?: Date;
  schedEnd?: Date;
}

const minutes = (m: number) => m * 60_000;

/**
 * Which instants belong to work date D (§6.3). Needs D−1, D, D+1.
 *
 * - A working day spans [start − early, end + late].
 * - Two consecutive working days whose spans overlap split at the midpoint of
 *   the rest gap; if they do not overlap, the gap belongs to the earlier day
 *   (a late stayer is overtime, not a 3 a.m. arrival).
 * - Off days take what working days leave, bounded by the local day boundary;
 *   a working day next to an off day stretches to that boundary.
 *
 * Every instant therefore maps to exactly one work date.
 */
export function punchWindow(
  prev: Slot,
  cur: Slot,
  next: Slot,
  policy: WindowPolicy,
  tz: string,
  dayBoundary: string,
): { windowStart: Date; windowEnd: Date } {
  const rawStart = (s: Slot) => new Date(s.schedStart!.getTime() - minutes(policy.earlyWindowMinutes));
  const rawEnd = (s: Slot) => new Date(s.schedEnd!.getTime() + minutes(policy.lateWindowMinutes));
  const boundary = (date: Ymd) => zonedInstant(date, dayBoundary, tz);

  /** Boundary between two consecutive days a → b. */
  const between = (a: Slot, b: Slot): Date => {
    if (a.working && b.working) {
      if (rawEnd(a) > rawStart(b)) {
        return new Date((a.schedEnd!.getTime() + b.schedStart!.getTime()) / 2);
      }
      return rawStart(b);
    }
    if (a.working) return new Date(Math.max(rawEnd(a).getTime(), boundary(b.date).getTime()));
    if (b.working) return new Date(Math.min(rawStart(b).getTime(), boundary(b.date).getTime()));
    return boundary(b.date);
  };

  const windowStart = between(prev, cur);
  const windowEnd = between(cur, next);
  // ponytail: pathological rosters (a 2 a.m. shift right after a long night) can
  // invert an off day's window; it collapses to empty instead of overlapping.
  return { windowStart, windowEnd: windowEnd < windowStart ? windowStart : windowEnd };
}

export function slotOf(day: ResolvedDay, tz: string): Slot {
  if (day.dayType !== 'WORKING' || !day.shift) return { date: day.date, working: false };
  const { schedStart, schedEnd } = shiftInstants(day.date, day.shift, tz);
  return { date: day.date, working: true, schedStart, schedEnd };
}
