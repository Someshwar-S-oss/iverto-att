/**
 * Report catalogue (§11.1). Each definition turns the shared filter object into
 * sections of rows; the same data drives the on-screen preview, the CSV and the
 * PDF, so the three can never disagree.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { STATUS_CODE, statusCode } from '../attendance/present';
import { dbDate, eachDay, formatLocal, leaveYearOf, ymdOf } from '../common/time';

export interface ReportFilters {
  dateFrom?: string;
  dateTo?: string;
  /** Relative period, resolved at run time in the tenant timezone (scheduled reports). */
  period?: 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth';
  siteIds?: string[];
  departmentIds?: string[];
  projectIds?: string[];
  employeeIds?: string[];
  statuses?: string[];
  groupBy?: 'none' | 'department' | 'project' | 'site';
}

export interface Column {
  key: string;
  label: string;
  align?: 'right' | 'center';
  /** Render as a status badge in the PDF. */
  badge?: boolean;
}

export interface Section {
  title?: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
}

export interface ReportData {
  kpis: Array<{ label: string; value: string | number; tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }>;
  chart?: { title: string; bars: Array<{ label: string; value: number }> };
  sections: Section[];
  /** Adds signature lines (timesheet). */
  signOff?: boolean;
}

export interface ReportContext {
  prisma: PrismaClient;
  tenantId: string;
  from: string;
  to: string;
  filters: ReportFilters;
  employeeWhere: Prisma.EmployeeWhereInput;
}

export interface ReportDefinition {
  type: string;
  title: string;
  description: string;
  formats: Array<'csv' | 'pdf'>;
  paper: { format: 'A4' | 'A3'; landscape: boolean };
  /** Filters the UI should offer. */
  filters: Array<keyof ReportFilters>;
  maxDays: number;
  run(ctx: ReportContext): Promise<ReportData>;
}

const hm = (minutes: number) => (minutes ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : '');
const pct = (n: number, d: number) => (d ? `${Math.round((n * 1000) / d) / 10}%` : '–');
const COMMON: Array<keyof ReportFilters> = ['dateFrom', 'dateTo', 'period', 'siteIds', 'departmentIds', 'projectIds', 'employeeIds'];

/** Employees matching scope + filters; project = membership overlapping the range (§11.1). */
export function employeeFilter(ctx: ReportContext): Prisma.EmployeeWhereInput {
  const f = ctx.filters;
  return {
    AND: [
      ctx.employeeWhere,
      f.siteIds?.length ? { siteId: { in: f.siteIds } } : {},
      f.departmentIds?.length ? { departmentId: { in: f.departmentIds } } : {},
      f.employeeIds?.length ? { id: { in: f.employeeIds } } : {},
      f.projectIds?.length
        ? {
            projects: {
              some: { projectId: { in: f.projectIds }, from: { lte: dbDate(ctx.to) }, OR: [{ to: null }, { to: { gte: dbDate(ctx.from) } }] },
            },
          }
        : {},
    ],
  };
}

type DayWithEmployee = Prisma.AttendanceDayGetPayload<{ include: { employee: { include: { department: true; site: true; projects: { include: { project: true } } } } } }>;

async function loadDays(ctx: ReportContext, extra: Prisma.AttendanceDayWhereInput = {}): Promise<DayWithEmployee[]> {
  return ctx.prisma.attendanceDay.findMany({
    where: {
      tenantId: ctx.tenantId,
      workDate: { gte: dbDate(ctx.from), lte: dbDate(ctx.to) },
      employee: employeeFilter(ctx),
      ...(ctx.filters.statuses?.length ? { status: { in: ctx.filters.statuses } } : {}),
      ...extra,
    },
    include: { employee: { include: { department: true, site: true, projects: { include: { project: true } } } } },
    orderBy: [{ employee: { fullName: 'asc' } }, { workDate: 'asc' }],
  });
}

function groupOf(e: DayWithEmployee['employee'], by: ReportFilters['groupBy'], from: string): string {
  if (by === 'department') return e.department?.name ?? 'No department';
  if (by === 'site') return e.site.name;
  if (by === 'project') return e.projects.find((p) => !p.to || ymdOf(p.to) >= from)?.project.name ?? 'No project';
  return '';
}

function grouped<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

const statusCounts = (days: Array<{ status: string }>) => {
  const c: Record<string, number> = {};
  for (const d of days) c[d.status] = (c[d.status] ?? 0) + 1;
  return c;
};

const dayRow = (d: DayWithEmployee) => ({
  code: d.employee.employeeCode,
  name: d.employee.fullName,
  department: d.employee.department?.name ?? '',
  date: ymdOf(d.workDate),
  scheduled: d.schedStart ? `${formatLocal(d.schedStart, d.timezone)}–${formatLocal(d.schedEnd, d.timezone)}` : d.dayType === 'WORKING' ? '' : d.holidayName ?? 'Off',
  in: formatLocal(d.firstIn, d.timezone) ?? '',
  out: formatLocal(d.lastOut, d.timezone) ?? '',
  worked: hm(d.workedMinutes),
  break: hm(d.breakMinutes),
  late: d.isLate ? hm(d.lateMinutes) : '',
  early: d.isEarlyExit ? hm(d.earlyExitMinutes) : '',
  ot: hm(d.overtimeMinutes),
  status: statusCode(d),
  flags: [d.missedPunch && 'missed punch', d.corrected && 'corrected', d.hasLeaveConflict && 'leave conflict'].filter(Boolean).join(', '),
});

export const REPORTS: ReportDefinition[] = [
  {
    type: 'daily-summary',
    title: 'Daily Attendance Summary',
    description: 'One row per employee for a date, with department/project subtotals.',
    formats: ['pdf', 'csv'],
    paper: { format: 'A4', landscape: false },
    filters: [...COMMON, 'statuses', 'groupBy'],
    maxDays: 1,
    async run(ctx) {
      const days = await loadDays(ctx);
      const c = statusCounts(days);
      const groups = grouped(days, (d) => groupOf(d.employee, ctx.filters.groupBy, ctx.from));
      const columns: Column[] = [
        { key: 'code', label: 'Code' },
        { key: 'name', label: 'Employee' },
        { key: 'scheduled', label: 'Shift' },
        { key: 'in', label: 'In', align: 'center' },
        { key: 'out', label: 'Out', align: 'center' },
        { key: 'worked', label: 'Worked', align: 'right' },
        { key: 'late', label: 'Late', align: 'right' },
        { key: 'ot', label: 'OT', align: 'right' },
        { key: 'status', label: 'Status', align: 'center', badge: true },
      ];
      return {
        kpis: [
          { label: 'Present', value: (c.PRESENT ?? 0) + (c.REMOTE ?? 0), tone: 'success' },
          { label: 'Half day', value: c.HALF_DAY ?? 0, tone: 'warning' },
          { label: 'Absent', value: c.ABSENT ?? 0, tone: 'danger' },
          { label: 'On leave', value: (c.ON_LEAVE ?? 0) + (c.HALF_LEAVE ?? 0), tone: 'info' },
          { label: 'Late', value: days.filter((d) => d.isLate).length, tone: 'warning' },
        ],
        sections: [...groups].map(([title, rows]) => {
          const g = statusCounts(rows);
          return {
            title: title || undefined,
            columns,
            rows: rows.map(dayRow),
            totals: { name: `${rows.length} employees`, status: `P ${g.PRESENT ?? 0} · A ${g.ABSENT ?? 0} · L ${g.ON_LEAVE ?? 0}` },
          };
        }),
      };
    },
  },
  {
    type: 'muster-roll',
    title: 'Monthly Muster Roll',
    description: 'Employee × day grid of status codes with totals (attendance register).',
    formats: ['pdf', 'csv'],
    paper: { format: 'A3', landscape: true },
    filters: COMMON,
    maxDays: 31,
    async run(ctx) {
      const days = await loadDays(ctx);
      const dates = eachDay(ctx.from, ctx.to);
      const byEmp = grouped(days, (d) => d.employeeId);
      const columns: Column[] = [
        { key: 'code', label: 'Code' },
        { key: 'name', label: 'Employee' },
        ...dates.map((d) => ({ key: d, label: d.slice(8), align: 'center' as const })),
        ...['P', 'A', 'HD', 'L', 'R', 'H', 'WO', 'LT'].map((k) => ({ key: `t_${k}`, label: k, align: 'right' as const })),
        { key: 't_OT', label: 'OT h', align: 'right' },
      ];
      const rows = [...byEmp.values()].map((list) => {
        const e = list[0].employee;
        const row: Record<string, unknown> = { code: e.employeeCode, name: e.fullName, department: e.department?.name ?? '' };
        for (const d of list) row[ymdOf(d.workDate)] = statusCode(d) + (d.isLate ? '*' : '');
        const count = (s: string) => list.filter((d) => d.status === s).length;
        Object.assign(row, {
          t_P: count('PRESENT'),
          t_A: count('ABSENT'),
          t_HD: count('HALF_DAY'),
          t_L: count('ON_LEAVE') + count('HALF_LEAVE') / 2,
          t_R: count('REMOTE'),
          t_H: count('HOLIDAY'),
          t_WO: count('WEEKLY_OFF'),
          t_LT: list.filter((d) => d.isLate).length,
          t_OT: Math.round(list.reduce((s, d) => s + d.overtimeMinutes, 0) / 6) / 10,
        });
        return row;
      });
      // Big departments get their own sections so each starts on a fresh page.
      const byDept = grouped(rows, (r) => String(r.department));
      return {
        kpis: Object.entries(STATUS_CODE)
          .filter(([s]) => s !== 'PENDING')
          .map(([s, code]) => ({ label: code, value: days.filter((d) => d.status === s).length })),
        sections: [...byDept].map(([title, list]) => ({ title: title || 'No department', columns, rows: list })),
      };
    },
  },
  {
    type: 'timesheet',
    title: 'Timesheet',
    description: 'Per employee per day: shift, scheduled, in, out, worked, break, late, early, OT; totals and sign-off.',
    formats: ['pdf', 'csv'],
    paper: { format: 'A4', landscape: true },
    filters: COMMON,
    maxDays: 62,
    async run(ctx) {
      const days = await loadDays(ctx);
      const byEmp = grouped(days, (d) => d.employeeId);
      const columns: Column[] = [
        { key: 'date', label: 'Date' },
        { key: 'scheduled', label: 'Scheduled' },
        { key: 'in', label: 'In', align: 'center' },
        { key: 'out', label: 'Out', align: 'center' },
        { key: 'worked', label: 'Worked', align: 'right' },
        { key: 'break', label: 'Break', align: 'right' },
        { key: 'late', label: 'Late', align: 'right' },
        { key: 'early', label: 'Early', align: 'right' },
        { key: 'ot', label: 'OT', align: 'right' },
        { key: 'status', label: 'Status', align: 'center', badge: true },
        { key: 'flags', label: 'Notes' },
      ];
      return {
        kpis: [
          { label: 'Employees', value: byEmp.size },
          { label: 'Worked (h)', value: Math.round(days.reduce((s, d) => s + d.workedMinutes, 0) / 60) },
          { label: 'Overtime (h)', value: Math.round(days.reduce((s, d) => s + d.overtimeMinutes, 0) / 60) },
          { label: 'Late days', value: days.filter((d) => d.isLate).length, tone: 'warning' },
        ],
        sections: [...byEmp.values()].map((list) => ({
          title: `${list[0].employee.fullName} (${list[0].employee.employeeCode})`,
          columns,
          rows: list.map((d) => ({ ...dayRow(d), name: d.employee.fullName, code: d.employee.employeeCode })),
          totals: {
            date: 'Total',
            worked: hm(list.reduce((s, d) => s + d.workedMinutes, 0)),
            break: hm(list.reduce((s, d) => s + d.breakMinutes, 0)),
            late: hm(list.reduce((s, d) => s + d.lateMinutes, 0)),
            early: hm(list.reduce((s, d) => s + d.earlyExitMinutes, 0)),
            ot: hm(list.reduce((s, d) => s + d.overtimeMinutes, 0)),
          },
        })),
        signOff: true,
      };
    },
  },
  {
    type: 'punch-log',
    title: 'Master Punch Log',
    description: 'Every punch with local time, UTC, device, source and correction trail — the audit report.',
    formats: ['csv', 'pdf'],
    paper: { format: 'A4', landscape: true },
    filters: COMMON,
    maxDays: 62,
    async run(ctx) {
      const punches = await ctx.prisma.punch.findMany({
        where: {
          tenantId: ctx.tenantId,
          punchedAt: { gte: new Date(dbDate(ctx.from).getTime() - 14 * 3_600_000), lt: new Date(dbDate(ctx.to).getTime() + 38 * 3_600_000) },
          AND: [
            { OR: [{ workDate: { gte: dbDate(ctx.from), lte: dbDate(ctx.to) } }, { workDate: null }] },
            // Unattributed punches belong in the audit log unless the filter names people.
            ctx.filters.employeeIds?.length || ctx.filters.departmentIds?.length || ctx.filters.projectIds?.length
              ? { employee: employeeFilter(ctx) }
              : { OR: [{ employee: employeeFilter(ctx) }, { employeeId: null }] },
          ],
          ...(ctx.filters.siteIds?.length ? { siteId: { in: ctx.filters.siteIds } } : {}),
        },
        include: { employee: true, device: true },
        orderBy: { punchedAt: 'asc' },
      });
      const sites = new Map((await ctx.prisma.site.findMany({ where: { tenantId: ctx.tenantId } })).map((s) => [s.id, s]));
      const corrections = new Map(
        (await ctx.prisma.attendanceCorrection.findMany({ where: { id: { in: punches.map((p) => p.correctionId).filter((x): x is string => !!x) } } })).map((c) => [c.id, c]),
      );
      const approvers = new Map(
        (await ctx.prisma.userProfile.findMany({ where: { userId: { in: [...corrections.values()].map((c) => c.approverId).filter((x): x is string => !!x) } } })).map((u) => [u.userId, u.displayName]),
      );
      const rows = punches.map((p) => {
        const site = sites.get(p.siteId);
        const tz = site?.timezone ?? 'UTC';
        const c = p.correctionId ? corrections.get(p.correctionId) : null;
        return {
          local: `${formatLocal(p.punchedAt, tz, 'yyyy-MM-dd HH:mm:ss')} ${formatLocal(p.punchedAt, tz, 'xxx')}`,
          utc: p.punchedAt.toISOString(),
          workDate: p.workDate ? ymdOf(p.workDate) : '',
          code: p.employee?.employeeCode ?? '',
          name: p.employee?.fullName ?? 'UNKNOWN',
          device: p.device ? `${p.device.serialNo}${p.device.name ? ` (${p.device.name})` : ''}` : '',
          site: site?.name ?? '',
          direction: p.direction,
          source: p.source,
          outcome: p.outcome,
          logId: p.deviceLogId ?? '',
          slot: p.terminalUserId ?? '',
          correction: c?.id ?? '',
          approver: c?.approverId ? approvers.get(c.approverId) ?? c.approverId : '',
          reason: p.reason ?? c?.reason ?? '',
        };
      });
      const count = (s: string) => punches.filter((p) => p.source === s).length;
      return {
        kpis: [
          { label: 'Punches', value: punches.length },
          { label: 'Terminal', value: count('TERMINAL') },
          { label: 'Mobile', value: count('MOBILE') },
          { label: 'Corrections', value: count('CORRECTION'), tone: 'warning' },
          { label: 'Manual', value: count('MANUAL'), tone: 'warning' },
          { label: 'Unattributed', value: punches.filter((p) => !p.employeeId).length, tone: 'danger' },
        ],
        sections: [
          {
            columns: [
              { key: 'local', label: 'Local time' },
              { key: 'utc', label: 'UTC' },
              { key: 'workDate', label: 'Work date' },
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Employee' },
              { key: 'device', label: 'Device' },
              { key: 'site', label: 'Site' },
              { key: 'direction', label: 'Dir' },
              { key: 'source', label: 'Source', badge: true },
              { key: 'outcome', label: 'Outcome' },
              { key: 'logId', label: 'LogID', align: 'right' },
              { key: 'slot', label: 'Slot', align: 'right' },
              { key: 'correction', label: 'Correction' },
              { key: 'approver', label: 'Approver' },
              { key: 'reason', label: 'Reason' },
            ],
            rows,
          },
        ],
      };
    },
  },
  {
    type: 'late-early',
    title: 'Late & Early Report',
    description: 'Late arrivals and early exits: occurrences and minutes per employee.',
    formats: ['pdf', 'csv'],
    paper: { format: 'A4', landscape: false },
    filters: [...COMMON, 'groupBy'],
    maxDays: 92,
    async run(ctx) {
      const days = await loadDays(ctx, { OR: [{ isLate: true }, { isEarlyExit: true }] });
      const byEmp = [...grouped(days, (d) => d.employeeId).values()];
      const rows = byEmp
        .map((list) => ({
          code: list[0].employee.employeeCode,
          name: list[0].employee.fullName,
          department: list[0].employee.department?.name ?? '',
          lateCount: list.filter((d) => d.isLate).length,
          lateMinutes: list.reduce((s, d) => s + d.lateMinutes, 0),
          earlyCount: list.filter((d) => d.isEarlyExit).length,
          earlyMinutes: list.reduce((s, d) => s + d.earlyExitMinutes, 0),
          dates: list.map((d) => `${ymdOf(d.workDate).slice(5)}${d.isLate ? ' L' : ''}${d.isEarlyExit ? ' E' : ''}`).join(', '),
        }))
        .sort((a, b) => b.lateMinutes + b.earlyMinutes - (a.lateMinutes + a.earlyMinutes));
      return {
        kpis: [
          { label: 'Late arrivals', value: days.filter((d) => d.isLate).length, tone: 'warning' },
          { label: 'Early exits', value: days.filter((d) => d.isEarlyExit).length, tone: 'warning' },
          { label: 'Employees', value: rows.length },
        ],
        chart: { title: 'Late minutes, top 10', bars: rows.slice(0, 10).map((r) => ({ label: r.name, value: r.lateMinutes })) },
        sections: [
          {
            columns: [
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Employee' },
              { key: 'department', label: 'Department' },
              { key: 'lateCount', label: 'Late', align: 'right' },
              { key: 'lateMinutes', label: 'Late min', align: 'right' },
              { key: 'earlyCount', label: 'Early', align: 'right' },
              { key: 'earlyMinutes', label: 'Early min', align: 'right' },
              { key: 'dates', label: 'Dates (MM-DD)' },
            ],
            rows,
          },
        ],
      };
    },
  },
  {
    type: 'overtime',
    title: 'Overtime Report',
    description: 'Overtime minutes per employee and day, including work on off days.',
    formats: ['pdf', 'csv'],
    paper: { format: 'A4', landscape: false },
    filters: COMMON,
    maxDays: 92,
    async run(ctx) {
      const days = await loadDays(ctx, { overtimeMinutes: { gt: 0 } });
      const rows = days.map((d) => ({
        code: d.employee.employeeCode,
        name: d.employee.fullName,
        date: ymdOf(d.workDate),
        dayType: d.dayType,
        worked: hm(d.workedMinutes),
        required: hm(d.requiredMinutes),
        overtime: hm(d.overtimeMinutes),
        offDay: d.workedOnOffDay ? 'yes' : '',
      }));
      const byEmp = [...grouped(days, (d) => d.employee.fullName)].map(([label, l]) => ({ label, value: Math.round(l.reduce((s, d) => s + d.overtimeMinutes, 0) / 6) / 10 }));
      return {
        kpis: [
          { label: 'Overtime (h)', value: Math.round(days.reduce((s, d) => s + d.overtimeMinutes, 0) / 6) / 10 },
          { label: 'Off-day work days', value: days.filter((d) => d.workedOnOffDay).length, tone: 'info' },
          { label: 'Employees', value: byEmp.length },
        ],
        chart: { title: 'Overtime hours by employee', bars: byEmp.sort((a, b) => b.value - a.value).slice(0, 10) },
        sections: [
          {
            columns: [
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Employee' },
              { key: 'date', label: 'Date' },
              { key: 'dayType', label: 'Day' },
              { key: 'worked', label: 'Worked', align: 'right' },
              { key: 'required', label: 'Required', align: 'right' },
              { key: 'overtime', label: 'OT', align: 'right' },
              { key: 'offDay', label: 'Off day', align: 'center' },
            ],
            rows,
          },
        ],
      };
    },
  },
  {
    type: 'leave',
    title: 'Leave Report',
    description: 'Leave taken per type in the period, and balances as of the end date (from the ledger).',
    formats: ['pdf', 'csv'],
    paper: { format: 'A4', landscape: true },
    filters: COMMON,
    maxDays: 366,
    async run(ctx) {
      const employees = await ctx.prisma.employee.findMany({ where: employeeFilter(ctx), orderBy: { fullName: 'asc' } });
      const ids = employees.map((e) => e.id);
      const year = leaveYearOf(ctx.to);
      const [types, requests, ledger] = await Promise.all([
        ctx.prisma.leaveType.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { code: 'asc' } }),
        ctx.prisma.leaveRequest.findMany({
          where: { employeeId: { in: ids }, status: 'APPROVED', startDate: { lte: dbDate(ctx.to) }, endDate: { gte: dbDate(ctx.from) } },
        }),
        ctx.prisma.leaveLedger.groupBy({ by: ['employeeId', 'leaveTypeId'], where: { employeeId: { in: ids }, leaveYear: year }, _sum: { delta: true } }),
      ]);
      const used = types.filter((t) => t.active || requests.some((r) => r.leaveTypeId === t.id));
      const rows = employees.map((e) => {
        const row: Record<string, unknown> = { code: e.employeeCode, name: e.fullName };
        for (const t of used) {
          row[`taken_${t.code}`] = requests.filter((r) => r.employeeId === e.id && r.leaveTypeId === t.id).reduce((s, r) => s + Number(r.days), 0) || '';
          row[`bal_${t.code}`] = Number(ledger.find((l) => l.employeeId === e.id && l.leaveTypeId === t.id)?._sum.delta ?? 0);
        }
        return row;
      });
      return {
        kpis: used.map((t) => ({ label: `${t.code} taken`, value: requests.filter((r) => r.leaveTypeId === t.id).reduce((s, r) => s + Number(r.days), 0) })),
        sections: [
          {
            columns: [
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Employee' },
              ...used.map((t) => ({ key: `taken_${t.code}`, label: `${t.code} taken`, align: 'right' as const })),
              ...used.map((t) => ({ key: `bal_${t.code}`, label: `${t.code} bal.`, align: 'right' as const })),
            ],
            rows,
          },
        ],
      };
    },
  },
  {
    type: 'absenteeism',
    title: 'Absenteeism Report',
    description: 'Absent and half-day rates by department, project or site.',
    formats: ['pdf', 'csv'],
    paper: { format: 'A4', landscape: false },
    filters: [...COMMON, 'groupBy'],
    maxDays: 366,
    async run(ctx) {
      const days = await loadDays(ctx, { dayType: 'WORKING' });
      const by = ctx.filters.groupBy && ctx.filters.groupBy !== 'none' ? ctx.filters.groupBy : 'department';
      const rows = [...grouped(days, (d) => groupOf(d.employee, by, ctx.from))].map(([group, list]) => {
        const absent = list.filter((d) => d.status === 'ABSENT').length;
        const half = list.filter((d) => d.status === 'HALF_DAY').length;
        return {
          group,
          employees: new Set(list.map((d) => d.employeeId)).size,
          workingDays: list.length,
          absent,
          halfDay: half,
          absentRate: pct(absent, list.length),
          halfDayRate: pct(half, list.length),
          _rate: list.length ? absent / list.length : 0,
        };
      });
      const absent = days.filter((d) => d.status === 'ABSENT').length;
      return {
        kpis: [
          { label: 'Working days', value: days.length },
          { label: 'Absent', value: absent, tone: 'danger' },
          { label: 'Absent rate', value: pct(absent, days.length), tone: 'danger' },
        ],
        chart: { title: `Absent rate by ${by}`, bars: rows.map((r) => ({ label: r.group, value: Math.round(r._rate * 1000) / 10 })) },
        sections: [
          {
            columns: [
              { key: 'group', label: by[0].toUpperCase() + by.slice(1) },
              { key: 'employees', label: 'Employees', align: 'right' },
              { key: 'workingDays', label: 'Working days', align: 'right' },
              { key: 'absent', label: 'Absent', align: 'right' },
              { key: 'halfDay', label: 'Half day', align: 'right' },
              { key: 'absentRate', label: 'Absent %', align: 'right' },
              { key: 'halfDayRate', label: 'Half-day %', align: 'right' },
            ],
            rows,
          },
        ],
      };
    },
  },
];

export const reportByType = (type: string) => REPORTS.find((r) => r.type === type);
