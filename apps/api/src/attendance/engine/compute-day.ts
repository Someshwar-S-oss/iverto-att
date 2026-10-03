/**
 * The attendance engine (§6). Pure: AttendanceDay = f(schedule, punches, leave,
 * remote, policy, now). Every attendance rule lives here so it can be table-tested
 * in compute-day.spec.ts; everything else is loading, locking and saving.
 */

export type Direction = 'in' | 'out' | 'unknown';

export type DayStatus =
  | 'PENDING'
  | 'PRESENT'
  | 'HALF_DAY'
  | 'ABSENT'
  | 'ON_LEAVE'
  | 'HALF_LEAVE'
  | 'REMOTE'
  | 'HOLIDAY'
  | 'WEEKLY_OFF';

export type LiveState =
  | 'OFF'
  | 'ON_LEAVE'
  | 'NOT_YET_IN'
  | 'LATE_NOT_IN'
  | 'IN'
  | 'IN_LATE'
  | 'REMOTE'
  | 'ON_BREAK'
  | 'LEFT'
  | 'ABSENT';

export interface EnginePolicy {
  graceInMinutes: number;
  graceOutMinutes: number;
  halfDayMinPercent: number;
  fullDayMinPercent: number;
  duplicatePunchSeconds: number;
  minSessionMinutes: number;
  absentAfterMinutes: number;
  missedOutCredit: 'NONE' | 'UNTIL_SHIFT_END';
  overtimeEnabled: boolean;
  overtimeMinMinutes: number;
  breakDeduction: 'SHIFT_BREAK' | 'NONE';
  roundingMinutes: number;
}

export interface EngineDay {
  dayType: 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY';
  flexible: boolean;
  schedStart: Date | null;
  schedEnd: Date | null;
  coreStart: Date | null;
  coreEnd: Date | null;
  windowStart: Date;
  windowEnd: Date;
  requiredMinutes: number;
  shiftBreakMinutes: number;
}

export interface EnginePunch {
  at: Date;
  direction: Direction;
  source: 'TERMINAL' | 'MOBILE' | 'CORRECTION' | 'MANUAL' | string;
}

export interface EngineLeave {
  portion: 0.5 | 1;
  half: 'FIRST' | 'SECOND' | null;
  leaveTypeId: string;
}

export interface EngineInput {
  day: EngineDay;
  punches: EnginePunch[];
  leave: EngineLeave | null;
  remote: boolean;
  policy: EnginePolicy;
  now: Date;
}

export interface Segment {
  in: string;
  out: string | null;
  /** True when the out was supplied by `missedOutCredit`, not a punch. */
  credited?: boolean;
}

export interface EngineResult {
  firstIn: Date | null;
  lastOut: Date | null;
  segments: Segment[];
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  punchCount: number;
  status: DayStatus;
  liveState: LiveState;
  isLate: boolean;
  isEarlyExit: boolean;
  missedPunch: boolean;
  workedOnOffDay: boolean;
  hasLeaveConflict: boolean;
  corrected: boolean;
  /** Window not yet closed: status stays PENDING. */
  open: boolean;
}

const MIN = 60_000;
const mins = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / MIN));

/** Sort and collapse M50 double-reads. */
export function dedupePunches(punches: EnginePunch[], windowSeconds: number): EnginePunch[] {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const kept: EnginePunch[] = [];
  for (const p of sorted) {
    const last = kept[kept.length - 1];
    // A correction is a deliberate human statement; never collapse it.
    if (last && p.source !== 'CORRECTION' && p.at.getTime() - last.at.getTime() < windowSeconds * 1000) continue;
    kept.push(p);
  }
  return kept;
}

interface Pairing {
  segments: Array<{ in: Date; out: Date | null; credited?: boolean }>;
  missedPunch: boolean;
  /** Presence right now: true if the last segment is still open. */
  inside: boolean;
}

/** §6.4 pairing. */
function pair(punches: EnginePunch[], day: EngineDay, policy: EnginePolicy): Pairing {
  if (punches.length === 0) return { segments: [], missedPunch: false, inside: false };

  // Only bidirectional gates were used: first-in / last-out.
  if (punches.every((p) => p.direction === 'unknown')) {
    const first = punches[0].at;
    const last = punches[punches.length - 1].at;
    const hasOut = punches.length > 1 && mins(first, last) >= policy.minSessionMinutes;
    return { segments: [{ in: first, out: hasOut ? last : null }], missedPunch: false, inside: !hasOut };
  }

  // Directional walk; unknowns take the direction opposite to the current state.
  const segments: Pairing['segments'] = [];
  let inside = false;
  let missedPunch = false;
  for (const p of punches) {
    const dir = p.direction === 'unknown' ? (inside ? 'out' : 'in') : p.direction;
    if (dir === 'in') {
      if (!inside) {
        segments.push({ in: p.at, out: null });
        inside = true;
      } // in,in → keep the first
    } else if (inside) {
      segments[segments.length - 1].out = p.at;
      inside = false;
    } else if (segments.length) {
      segments[segments.length - 1].out = p.at; // out,out → keep the last
    } else {
      missedPunch = true; // leading out with no in: ignored
    }
  }
  return { segments, missedPunch, inside };
}

export function computeAttendanceDay(input: EngineInput): EngineResult {
  const { day, leave, remote, policy, now } = input;
  const open = now < day.windowEnd;
  const punches = dedupePunches(input.punches, policy.duplicatePunchSeconds);
  const corrected = punches.some((p) => p.source === 'CORRECTION');
  const firstLast = punches.length > 0 && punches.every((p) => p.direction === 'unknown');

  const pairing = pair(punches, day, policy);
  let { missedPunch } = pairing;
  const segments = pairing.segments.map((s) => ({ ...s }));

  // Trailing in without out.
  const tail = segments[segments.length - 1];
  if (tail && !tail.out && !open) {
    missedPunch = true;
    if (policy.missedOutCredit === 'UNTIL_SHIFT_END' && day.schedEnd && day.schedEnd > tail.in) {
      tail.out = day.schedEnd;
      tail.credited = true;
    }
  }

  // Worked time: an open segment counts up to now while the day is open ("worked so far").
  let worked = 0;
  for (const s of segments) {
    const end = s.out ?? (open ? new Date(Math.min(now.getTime(), day.windowEnd.getTime())) : null);
    if (end) worked += mins(s.in, end);
  }
  let breakMinutes = 0;
  if (firstLast) {
    if (policy.breakDeduction === 'SHIFT_BREAK' && segments[0]?.out) {
      breakMinutes = Math.min(day.shiftBreakMinutes, worked);
      worked -= breakMinutes;
    }
  } else {
    for (let i = 1; i < segments.length; i++) {
      if (segments[i - 1].out) breakMinutes += mins(segments[i - 1].out!, segments[i].in);
    }
  }
  if (policy.roundingMinutes > 0) worked = Math.floor(worked / policy.roundingMinutes) * policy.roundingMinutes;

  const firstIn = segments[0]?.in ?? null;
  // A credited out is not an observed exit: no last-out, no early-exit judgement.
  const lastOut = tail?.out && !tail.credited ? tail.out : null;

  // ── Status (§6.5), first match wins ──────────────────────────────────────
  const offDay = day.dayType !== 'WORKING';
  const required = leave?.portion === 0.5 ? day.requiredMinutes / 2 : day.requiredMinutes;
  const fullMin = (day.requiredMinutes * policy.fullDayMinPercent) / 100;
  const halfMin = (day.requiredMinutes * policy.halfDayMinPercent) / 100;
  const hoursStatus = (): DayStatus =>
    day.requiredMinutes === 0 ? (worked > 0 ? 'PRESENT' : 'ABSENT') : worked >= fullMin ? 'PRESENT' : worked >= halfMin ? 'HALF_DAY' : 'ABSENT';

  let status: DayStatus;
  let hasLeaveConflict = false;
  let workedOnOffDay = false;
  let overtime = 0;

  if (offDay) {
    status = day.dayType as DayStatus;
    if (worked > 0) {
      workedOnOffDay = true;
      overtime = worked;
    }
  } else if (leave?.portion === 1) {
    status = 'ON_LEAVE';
    hasLeaveConflict = punches.length > 0;
  } else if (leave?.portion === 0.5) {
    // The remaining half has to be worked to the usual half-day threshold.
    status = worked >= halfMin ? 'HALF_LEAVE' : 'ABSENT';
  } else if (remote && worked >= halfMin) {
    status = worked >= fullMin ? 'REMOTE' : 'HALF_DAY';
  } else {
    status = hoursStatus();
  }

  // ── Flags against the schedule (flexible shifts: against core hours) ─────
  const refStart = day.flexible ? day.coreStart : day.schedStart;
  const refEnd = day.flexible ? day.coreEnd : day.schedEnd;
  let lateMinutes = 0;
  let earlyExitMinutes = 0;
  const judged = !offDay && leave?.portion !== 1;
  if (judged && firstIn && refStart && leave?.half !== 'FIRST') {
    const late = mins(refStart, firstIn);
    if (late > policy.graceInMinutes) lateMinutes = late;
  }
  if (judged && lastOut && refEnd && leave?.half !== 'SECOND') {
    const early = mins(lastOut, refEnd);
    if (early > policy.graceOutMinutes) earlyExitMinutes = early;
  }
  if (judged && policy.overtimeEnabled) {
    const extra = worked - required;
    if (extra >= policy.overtimeMinMinutes) overtime = extra;
  }

  const result: EngineResult = {
    firstIn,
    lastOut,
    segments: segments.map((s) => ({
      in: s.in.toISOString(),
      out: s.out ? s.out.toISOString() : null,
      ...(s.credited && { credited: true }),
    })),
    workedMinutes: worked,
    breakMinutes,
    lateMinutes,
    earlyExitMinutes,
    overtimeMinutes: overtime,
    punchCount: punches.length,
    status: open ? 'PENDING' : status,
    liveState: 'OFF',
    isLate: lateMinutes > 0,
    isEarlyExit: earlyExitMinutes > 0,
    missedPunch,
    workedOnOffDay,
    hasLeaveConflict,
    corrected,
    open,
  };
  result.liveState = liveStateOf(input, result, pairing.inside, status);
  return result;
}

/** §6.5 live state — what the real-time board shows. */
function liveStateOf(input: EngineInput, r: EngineResult, inside: boolean, finalStatus: DayStatus): LiveState {
  const { day, leave, remote, policy, now } = input;
  if (inside && r.open) return r.isLate ? 'IN_LATE' : remote ? 'REMOTE' : 'IN';
  if (day.dayType !== 'WORKING') return r.punchCount && r.open ? 'LEFT' : 'OFF';
  if (leave?.portion === 1) return 'ON_LEAVE';
  if (r.punchCount > 0) {
    if (!r.open) return finalStatus === 'ABSENT' ? 'ABSENT' : 'LEFT';
    const expectedBack = day.schedEnd && now.getTime() < day.schedEnd.getTime() - policy.graceOutMinutes * MIN;
    return expectedBack ? 'ON_BREAK' : 'LEFT';
  }
  if (remote) return 'REMOTE';
  if (leave?.portion === 0.5 && leave.half === 'FIRST') return 'ON_LEAVE';
  const start = day.flexible ? day.coreStart ?? day.schedStart : day.schedStart;
  if (!start || !r.open) return 'ABSENT';
  const late = now.getTime() - start.getTime();
  if (late >= policy.absentAfterMinutes * MIN) return 'ABSENT';
  if (late > policy.graceInMinutes * MIN) return 'LATE_NOT_IN';
  return 'NOT_YET_IN';
}
