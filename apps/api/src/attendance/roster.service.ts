import { Injectable } from '@nestjs/common';
import { AttendanceDay, AttendancePolicy, Employee, Prisma, Shift } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { addDays, dbDate, eachDay, localYmd, Ymd, ymdOf } from '../common/time';
import { EngineDay, EnginePolicy } from './engine/compute-day';
import {
  PatternDef,
  punchWindow,
  resolveDay,
  RosterData,
  ScheduleDef,
  ShiftDef,
  shiftInstants,
  slotOf,
} from './engine/schedule';

/** Tenant-wide inputs for resolving anybody's roster. */
export interface TenantRoster {
  tenantId: string;
  dayBoundary: string;
  shifts: Map<string, ShiftDef>;
  patterns: Map<string, PatternDef>;
  policies: Map<string, AttendancePolicy>;
  defaultPolicy: AttendancePolicy | null;
  departmentPolicy: Map<string, string | null>;
  siteTz: Map<string, string>;
  siteCalendar: Map<string, string | null>;
  holidays: Map<string, Map<Ymd, string>>; // calendarId → date → name
}

export type DayPlan = Omit<Prisma.AttendanceDayUncheckedCreateInput, 'id'>;

export const toShiftDef = (s: Shift): ShiftDef => ({
  id: s.id,
  kind: s.kind as ShiftDef['kind'],
  startTime: s.startTime,
  endTime: s.endTime,
  breakMinutes: s.breakMinutes,
  requiredMinutes: s.requiredMinutes,
  coreStart: s.coreStart,
  coreEnd: s.coreEnd,
  worksHolidays: s.worksHolidays,
  policyId: s.policyId,
});

export function policySnapshot(p: AttendancePolicy | null): EnginePolicy & Record<string, unknown> {
  return {
    graceInMinutes: p?.graceInMinutes ?? 10,
    graceOutMinutes: p?.graceOutMinutes ?? 10,
    halfDayMinPercent: p?.halfDayMinPercent ?? 50,
    fullDayMinPercent: p?.fullDayMinPercent ?? 90,
    earlyWindowMinutes: p?.earlyWindowMinutes ?? 180,
    lateWindowMinutes: p?.lateWindowMinutes ?? 360,
    duplicatePunchSeconds: p?.duplicatePunchSeconds ?? 60,
    minSessionMinutes: p?.minSessionMinutes ?? 5,
    absentAfterMinutes: p?.absentAfterMinutes ?? 120,
    missedOutCredit: (p?.missedOutCredit ?? 'NONE') as EnginePolicy['missedOutCredit'],
    overtimeEnabled: p?.overtimeEnabled ?? false,
    overtimeMinMinutes: p?.overtimeMinMinutes ?? 30,
    breakDeduction: (p?.breakDeduction ?? 'SHIFT_BREAK') as EnginePolicy['breakDeduction'],
    roundingMinutes: p?.roundingMinutes ?? 0,
  };
}

/** The frozen schedule on an attendance_days row, in engine terms. */
export function engineDayOf(row: AttendanceDay): EngineDay {
  return {
    dayType: row.dayType as EngineDay['dayType'],
    flexible: row.shiftKind === 'FLEXIBLE',
    schedStart: row.schedStart,
    schedEnd: row.schedEnd,
    coreStart: row.coreStart,
    coreEnd: row.coreEnd,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    requiredMinutes: row.requiredMinutes,
    shiftBreakMinutes: row.shiftBreakMinutes,
  };
}

/**
 * Turns shifts/patterns/schedules/overrides/holidays into the frozen per-day
 * plan on `attendance_days` (§7.2). The Roster Planner reads the same rows, so
 * what a manager sees is exactly what the engine judges against.
 */
@Injectable()
export class RosterService {
  constructor(private readonly prisma: PrismaService) {}

  async tenantRoster(tenantId: string, from: Ymd, to: Ymd): Promise<TenantRoster> {
    const [tenant, shifts, patterns, policies, departments, sites, holidays] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.shift.findMany({ where: { tenantId } }),
      this.prisma.shiftPattern.findMany({ where: { tenantId } }),
      this.prisma.attendancePolicy.findMany({ where: { tenantId } }),
      this.prisma.department.findMany({ where: { tenantId }, select: { id: true, policyId: true } }),
      this.prisma.site.findMany({ where: { tenantId } }),
      this.prisma.holiday.findMany({
        where: { tenantId, date: { gte: dbDate(addDays(from, -2)), lte: dbDate(addDays(to, 2)) } },
      }),
    ]);
    const byCalendar = new Map<string, Map<Ymd, string>>();
    for (const h of holidays) {
      if (!byCalendar.has(h.calendarId)) byCalendar.set(h.calendarId, new Map());
      byCalendar.get(h.calendarId)!.set(ymdOf(h.date), h.name);
    }
    return {
      tenantId,
      dayBoundary: ((tenant?.settings as any)?.dayBoundary as string) || '04:00',
      shifts: new Map(shifts.map((s) => [s.id, toShiftDef(s)])),
      patterns: new Map(patterns.map((p) => [p.id, { id: p.id, cycleDays: p.cycleDays, days: p.days as (string | null)[] }])),
      policies: new Map(policies.map((p) => [p.id, p])),
      defaultPolicy: policies.find((p) => p.isDefault) ?? policies[0] ?? null,
      departmentPolicy: new Map(departments.map((d) => [d.id, d.policyId])),
      siteTz: new Map(sites.map((s) => [s.id, s.timezone])),
      siteCalendar: new Map(sites.map((s) => [s.id, s.holidayCalendarId])),
      holidays: byCalendar,
    };
  }

  /** Per-employee roster inputs for [from−2, to+2]. */
  async employeeRosters(tr: TenantRoster, employees: Employee[], from: Ymd, to: Ymd): Promise<Map<string, RosterData>> {
    const ids = employees.map((e) => e.id);
    const [schedules, overrides] = await Promise.all([
      this.prisma.employeeSchedule.findMany({
        where: {
          employeeId: { in: ids },
          effectiveFrom: { lte: dbDate(addDays(to, 2)) },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: dbDate(addDays(from, -2)) } }],
        },
      }),
      this.prisma.rosterOverride.findMany({
        where: { employeeId: { in: ids }, date: { gte: dbDate(addDays(from, -2)), lte: dbDate(addDays(to, 2)) } },
      }),
    ]);
    const out = new Map<string, RosterData>();
    for (const e of employees) {
      const calendar = tr.siteCalendar.get(e.siteId);
      out.set(e.id, {
        shifts: tr.shifts,
        patterns: tr.patterns,
        schedules: schedules
          .filter((s) => s.employeeId === e.id)
          .map<ScheduleDef>((s) => ({
            effectiveFrom: ymdOf(s.effectiveFrom),
            effectiveTo: s.effectiveTo ? ymdOf(s.effectiveTo) : null,
            shiftId: s.shiftId,
            weeklyOffs: s.weeklyOffs,
            patternId: s.patternId,
            anchorDate: s.anchorDate ? ymdOf(s.anchorDate) : null,
          })),
        overrides: new Map(overrides.filter((o) => o.employeeId === e.id).map((o) => [ymdOf(o.date), o.shiftId])),
        holidays: (calendar && tr.holidays.get(calendar)) || new Map(),
      });
    }
    return out;
  }

  /** Shift policy → department policy → tenant default. */
  policyFor(tr: TenantRoster, employee: Employee, shift: ShiftDef | null): AttendancePolicy | null {
    const id = shift?.policyId ?? (employee.departmentId ? tr.departmentPolicy.get(employee.departmentId) : null);
    return (id && tr.policies.get(id)) || tr.defaultPolicy;
  }

  planDay(tr: TenantRoster, employee: Employee, roster: RosterData, date: Ymd): DayPlan {
    const tz = tr.siteTz.get(employee.siteId) ?? 'Asia/Kolkata';
    const [prev, cur, next] = [addDays(date, -1), date, addDays(date, 1)].map((d) => resolveDay(roster, d));
    const policy = this.policyFor(tr, employee, cur.shift);
    const snapshot = policySnapshot(policy);
    const { windowStart, windowEnd } = punchWindow(
      slotOf(prev, tz),
      slotOf(cur, tz),
      slotOf(next, tz),
      { earlyWindowMinutes: snapshot.earlyWindowMinutes as number, lateWindowMinutes: snapshot.lateWindowMinutes as number },
      tz,
      tr.dayBoundary,
    );
    const inst = cur.dayType === 'WORKING' && cur.shift ? shiftInstants(date, cur.shift, tz) : null;
    return {
      tenantId: employee.tenantId,
      siteId: employee.siteId,
      employeeId: employee.id,
      workDate: dbDate(date),
      timezone: tz,
      dayType: cur.dayType,
      holidayName: cur.holidayName,
      shiftId: inst ? cur.shift!.id : null,
      shiftKind: inst ? cur.shift!.kind : null,
      shiftBreakMinutes: inst ? cur.shift!.breakMinutes : 0,
      schedStart: inst?.schedStart ?? null,
      schedEnd: inst?.schedEnd ?? null,
      coreStart: inst?.coreStart ?? null,
      coreEnd: inst?.coreEnd ?? null,
      windowStart,
      windowEnd,
      requiredMinutes: inst?.requiredMinutes ?? 0,
      policyId: policy?.id ?? null,
      policy: snapshot as Prisma.InputJsonValue,
    };
  }

  /**
   * Make sure plan rows exist for these employees over [from, to].
   * `refresh` rewrites the schedule snapshot on existing, not-yet-finalised rows
   * (or all rows when `includeFinalized`, i.e. HR ticked "re-evaluate history").
   * Returns the (employeeId, date) pairs that were created or changed.
   */
  async ensureDays(
    tenantId: string,
    employees: Employee[],
    from: Ymd,
    to: Ymd,
    opts: { refresh?: boolean; includeFinalized?: boolean; tr?: TenantRoster } = {},
  ): Promise<Array<{ employeeId: string; date: Ymd }>> {
    if (!employees.length || from > to) return [];
    const tr = opts.tr ?? (await this.tenantRoster(tenantId, from, to));
    const rosters = await this.employeeRosters(tr, employees, from, to);
    const existing = await this.prisma.attendanceDay.findMany({
      where: { employeeId: { in: employees.map((e) => e.id) }, workDate: { gte: dbDate(from), lte: dbDate(to) } },
      select: { id: true, employeeId: true, workDate: true, finalizedAt: true, shiftId: true, dayType: true, windowStart: true, windowEnd: true, schedStart: true, policy: true },
    });
    const byKey = new Map(existing.map((d) => [`${d.employeeId}:${ymdOf(d.workDate)}`, d]));

    const touched: Array<{ employeeId: string; date: Ymd }> = [];
    const creates: DayPlan[] = [];
    for (const e of employees) {
      const first = ymdOf(e.joinedOn) > from ? ymdOf(e.joinedOn) : from;
      const last = e.exitOn && ymdOf(e.exitOn) < to ? ymdOf(e.exitOn) : to;
      for (const date of eachDay(first, last)) {
        const plan = this.planDay(tr, e, rosters.get(e.id)!, date);
        const row = byKey.get(`${e.id}:${date}`);
        if (!row) {
          creates.push(plan);
          touched.push({ employeeId: e.id, date });
          continue;
        }
        if (!opts.refresh || (row.finalizedAt && !opts.includeFinalized)) continue;
        const same =
          row.shiftId === plan.shiftId &&
          row.dayType === plan.dayType &&
          row.windowStart.getTime() === (plan.windowStart as Date).getTime() &&
          row.windowEnd.getTime() === (plan.windowEnd as Date).getTime() &&
          (row.schedStart?.getTime() ?? null) === ((plan.schedStart as Date | null)?.getTime() ?? null) &&
          JSON.stringify(row.policy) === JSON.stringify(plan.policy);
        if (same && !opts.includeFinalized) continue;
        const { tenantId: _t, employeeId: _e, workDate: _w, ...schedule } = plan;
        await this.prisma.attendanceDay.update({ where: { id: row.id }, data: schedule });
        touched.push({ employeeId: e.id, date });
      }
    }
    if (creates.length) await this.prisma.attendanceDay.createMany({ data: creates, skipDuplicates: true });
    return touched;
  }

  /** Local "today" for an employee's site. */
  todayFor(tr: TenantRoster, employee: Pick<Employee, 'siteId'>, now = new Date()): Ymd {
    return localYmd(now, tr.siteTz.get(employee.siteId) ?? 'Asia/Kolkata');
  }
}
