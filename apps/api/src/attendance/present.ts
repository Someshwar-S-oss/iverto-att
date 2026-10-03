import { AttendanceDay, Punch } from '@prisma/client';
import { formatLocal, ymdOf } from '../common/time';

/** Muster-roll codes (§11.1). A half-leave day with the remaining half absent shows as A/½L. */
export const STATUS_CODE: Record<string, string> = {
  PRESENT: 'P',
  ABSENT: 'A',
  HALF_DAY: 'HD',
  ON_LEAVE: 'L',
  HALF_LEAVE: '½L',
  REMOTE: 'R',
  HOLIDAY: 'H',
  WEEKLY_OFF: 'WO',
  PENDING: '·',
};

export const statusCode = (d: { status: string; leavePortion: unknown }) =>
  d.status === 'ABSENT' && Number(d.leavePortion) === 0.5 ? 'A/½L' : STATUS_CODE[d.status] ?? d.status;

type EmployeeLite ={ id: string; fullName: string; employeeCode: string; departmentId: string | null; siteId: string };

/**
 * The one JSON shape of an attendance day — REST lists, the live board and the
 * socket deltas all send this, so the client can replace rows by employeeId.
 * Instants are ISO UTC; `local` repeats them as wall-clock in the day's site timezone.
 */
export function presentDay(day: AttendanceDay & { employee?: EmployeeLite | null }) {
  const tz = day.timezone;
  return {
    id: day.id,
    employeeId: day.employeeId,
    employee: day.employee
      ? {
          id: day.employee.id,
          fullName: day.employee.fullName,
          employeeCode: day.employee.employeeCode,
          departmentId: day.employee.departmentId,
          siteId: day.employee.siteId,
        }
      : undefined,
    siteId: day.siteId,
    workDate: ymdOf(day.workDate),
    timezone: tz,
    dayType: day.dayType,
    holidayName: day.holidayName,
    shiftId: day.shiftId,
    schedStart: day.schedStart,
    schedEnd: day.schedEnd,
    firstIn: day.firstIn,
    lastOut: day.lastOut,
    local: {
      schedStart: formatLocal(day.schedStart, tz),
      schedEnd: formatLocal(day.schedEnd, tz),
      firstIn: formatLocal(day.firstIn, tz),
      lastOut: formatLocal(day.lastOut, tz),
      offset: formatLocal(day.windowStart, tz, 'xxx'),
    },
    status: day.status,
    liveState: day.liveState,
    requiredMinutes: day.requiredMinutes,
    workedMinutes: day.workedMinutes,
    breakMinutes: day.breakMinutes,
    lateMinutes: day.lateMinutes,
    earlyExitMinutes: day.earlyExitMinutes,
    overtimeMinutes: day.overtimeMinutes,
    punchCount: day.punchCount,
    isLate: day.isLate,
    isEarlyExit: day.isEarlyExit,
    missedPunch: day.missedPunch,
    workedOnOffDay: day.workedOnOffDay,
    hasLeaveConflict: day.hasLeaveConflict,
    leavePortion: Number(day.leavePortion),
    leaveHalf: day.leaveHalf,
    leaveTypeId: day.leaveTypeId,
    remote: day.remote,
    corrected: day.corrected,
    segments: day.segments,
    finalizedAt: day.finalizedAt,
    computedAt: day.computedAt,
  };
}

type PunchWithNames = Punch & {
  employee?: { fullName: string; employeeCode: string } | null;
  device?: { name: string | null; serialNo: string; gateName: string } | null;
};

export function presentPunch(p: PunchWithNames, tz: string) {
  return {
    id: p.id,
    punchedAt: p.punchedAt,
    local: formatLocal(p.punchedAt, tz, 'yyyy-MM-dd HH:mm:ss'),
    offset: formatLocal(p.punchedAt, tz, 'xxx'),
    timezone: tz,
    employeeId: p.employeeId,
    employee: p.employee ? { fullName: p.employee.fullName, employeeCode: p.employee.employeeCode } : null,
    siteId: p.siteId,
    deviceId: p.deviceId,
    device: p.device ? { name: p.device.name, serialNo: p.device.serialNo, gateName: p.device.gateName } : null,
    terminalUserId: p.terminalUserId,
    deviceLogId: p.deviceLogId,
    source: p.source,
    direction: p.direction,
    outcome: p.outcome,
    workDate: p.workDate ? ymdOf(p.workDate) : null,
    lat: p.lat,
    lng: p.lng,
    accuracy: p.accuracy,
    isMockLocation: p.isMockLocation,
    correctionId: p.correctionId,
    reason: p.reason,
    createdBy: p.createdBy,
    hasPhoto: Boolean(p.photoKey),
    receivedAt: p.receivedAt,
  };
}
