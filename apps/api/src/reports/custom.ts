/**
 * Custom reports: a tenant-saved template (JSON spec) over a fixed catalogue of
 * data sources and fields. The spec picks columns, conditions and calculations;
 * nothing in it reaches SQL — the database query is always the source's own
 * scoped loader, and conditions/aggregates run on the loaded rows. Output is
 * plain ReportData, so CSV, PDF, schedules and audit work unchanged.
 */
import { Prisma } from '@prisma/client';
import { STATUS_CODE } from '../attendance/present';
import { AppError } from '../common/errors';
import { dbDate, formatLocal, weekday, ymdOf } from '../common/time';
import { Column, employeeFilter, grouped, hm, ReportContext, ReportData, ReportDefinition, Section } from './definitions';

// ── Catalogue ───────────────────────────────────────────────────────────────

export type FieldType = 'text' | 'number' | 'minutes' | 'date' | 'bool' | 'enum';
type Value = string | number | boolean | null;
type Option = { value: string; label: string };

interface Field<R> {
  key: string;
  label: string;
  type: FieldType;
  options?: Option[];
  get: (r: R) => Value;
}

interface Source<R> {
  key: string;
  label: string;
  description: string;
  /** One row is… (shown in the builder). */
  row: string;
  maxDays: number;
  load: (ctx: ReportContext) => Promise<R[]>;
  fields: Field<R>[];
}

const opts = (m: Record<string, string>): Option[] => Object.entries(m).map(([value, label]) => ({ value, label }));
const DAY_STATUS = opts({ PRESENT: 'Present', ABSENT: 'Absent', HALF_DAY: 'Half day', ON_LEAVE: 'On leave', HALF_LEAVE: 'Half leave', REMOTE: 'Remote', HOLIDAY: 'Holiday', WEEKLY_OFF: 'Weekly off', PENDING: 'Pending' });
const WEEKDAY = opts({ 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' });
const REQUEST = opts({ PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' });

type EmpRef = Prisma.EmployeeGetPayload<{ include: { department: true; site: true; manager: { select: { fullName: true } } } }>;
const EMP_INCLUDE = { department: true, site: true, manager: { select: { fullName: true } } } as const;

/** The same employee columns on every source. */
function employeeFields<R>(emp: (r: R) => EmpRef | null): Field<R>[] {
  return [
    { key: 'employeeCode', label: 'Employee code', type: 'text', get: (r) => emp(r)?.employeeCode ?? null },
    { key: 'employeeName', label: 'Employee', type: 'text', get: (r) => emp(r)?.fullName ?? null },
    { key: 'department', label: 'Department', type: 'text', get: (r) => emp(r)?.department?.name ?? 'No department' },
    { key: 'site', label: 'Site', type: 'text', get: (r) => emp(r)?.site.name ?? null },
    { key: 'designation', label: 'Designation', type: 'text', get: (r) => emp(r)?.designation ?? null },
    { key: 'employmentType', label: 'Employment type', type: 'enum', options: opts({ FULL_TIME: 'Full time', PART_TIME: 'Part time', CONTRACT: 'Contract', INTERN: 'Intern' }), get: (r) => emp(r)?.employmentType ?? null },
    { key: 'manager', label: 'Manager', type: 'text', get: (r) => emp(r)?.manager?.fullName ?? null },
  ];
}

type DayRow = Prisma.AttendanceDayGetPayload<{ include: { employee: { include: typeof EMP_INCLUDE } } }>;
type PunchRow = Prisma.PunchGetPayload<{ include: { employee: { include: typeof EMP_INCLUDE }; device: true } }> & { tz: string };
type LeaveRow = Prisma.LeaveRequestGetPayload<{ include: { employee: { include: typeof EMP_INCLUDE }; leaveType: true } }>;

const days: Source<DayRow> = {
  key: 'days',
  label: 'Attendance days',
  description: 'The judged attendance of each employee for each day: status, in/out, worked, late, overtime.',
  row: 'one employee on one day',
  maxDays: 92,
  load: (ctx) =>
    ctx.prisma.attendanceDay.findMany({
      where: { tenantId: ctx.tenantId, workDate: { gte: dbDate(ctx.from), lte: dbDate(ctx.to) }, employee: employeeFilter(ctx) },
      include: { employee: { include: EMP_INCLUDE } },
      orderBy: [{ employee: { fullName: 'asc' } }, { workDate: 'asc' }],
    }),
  fields: [
    { key: 'date', label: 'Date', type: 'date', get: (d) => ymdOf(d.workDate) },
    { key: 'month', label: 'Month', type: 'text', get: (d) => ymdOf(d.workDate).slice(0, 7) },
    { key: 'weekday', label: 'Weekday', type: 'enum', options: WEEKDAY, get: (d) => String(weekday(ymdOf(d.workDate))) },
    ...employeeFields<DayRow>((d) => d.employee),
    { key: 'status', label: 'Status', type: 'enum', options: DAY_STATUS, get: (d) => d.status },
    { key: 'statusCode', label: 'Status code', type: 'text', get: (d) => STATUS_CODE[d.status] ?? d.status },
    { key: 'dayType', label: 'Day type', type: 'enum', options: opts({ WORKING: 'Working', WEEKLY_OFF: 'Weekly off', HOLIDAY: 'Holiday' }), get: (d) => d.dayType },
    { key: 'holiday', label: 'Holiday name', type: 'text', get: (d) => d.holidayName },
    { key: 'shiftStart', label: 'Shift start', type: 'text', get: (d) => formatLocal(d.schedStart, d.timezone) },
    { key: 'shiftEnd', label: 'Shift end', type: 'text', get: (d) => formatLocal(d.schedEnd, d.timezone) },
    { key: 'firstIn', label: 'First in', type: 'text', get: (d) => formatLocal(d.firstIn, d.timezone) },
    { key: 'lastOut', label: 'Last out', type: 'text', get: (d) => formatLocal(d.lastOut, d.timezone) },
    { key: 'workedMinutes', label: 'Worked', type: 'minutes', get: (d) => d.workedMinutes },
    { key: 'requiredMinutes', label: 'Required', type: 'minutes', get: (d) => d.requiredMinutes },
    { key: 'breakMinutes', label: 'Break', type: 'minutes', get: (d) => d.breakMinutes },
    { key: 'lateMinutes', label: 'Late by', type: 'minutes', get: (d) => d.lateMinutes },
    { key: 'earlyExitMinutes', label: 'Left early by', type: 'minutes', get: (d) => d.earlyExitMinutes },
    { key: 'overtimeMinutes', label: 'Overtime', type: 'minutes', get: (d) => d.overtimeMinutes },
    { key: 'punchCount', label: 'Punches', type: 'number', get: (d) => d.punchCount },
    { key: 'leavePortion', label: 'Leave portion', type: 'number', get: (d) => Number(d.leavePortion) },
    { key: 'isLate', label: 'Late', type: 'bool', get: (d) => d.isLate },
    { key: 'isEarlyExit', label: 'Left early', type: 'bool', get: (d) => d.isEarlyExit },
    { key: 'missedPunch', label: 'Missed punch', type: 'bool', get: (d) => d.missedPunch },
    { key: 'remote', label: 'Remote', type: 'bool', get: (d) => d.remote },
    { key: 'corrected', label: 'Corrected', type: 'bool', get: (d) => d.corrected },
    { key: 'workedOnOffDay', label: 'Worked on off day', type: 'bool', get: (d) => d.workedOnOffDay },
  ],
};

const punches: Source<PunchRow> = {
  key: 'punches',
  label: 'Punches',
  description: 'Every scan, mobile punch and correction.',
  row: 'one punch',
  maxDays: 62,
  async load(ctx) {
    const rows = await ctx.prisma.punch.findMany({
      where: { tenantId: ctx.tenantId, workDate: { gte: dbDate(ctx.from), lte: dbDate(ctx.to) }, employee: employeeFilter(ctx) },
      include: { employee: { include: EMP_INCLUDE }, device: true },
      orderBy: { punchedAt: 'asc' },
    });
    return rows.map((p) => ({ ...p, tz: p.employee?.site.timezone ?? 'UTC' }));
  },
  fields: [
    { key: 'date', label: 'Work date', type: 'date', get: (p) => (p.workDate ? ymdOf(p.workDate) : null) },
    { key: 'time', label: 'Local time', type: 'text', get: (p) => formatLocal(p.punchedAt, p.tz, 'HH:mm:ss') },
    { key: 'hour', label: 'Hour of day', type: 'text', get: (p) => formatLocal(p.punchedAt, p.tz, 'HH:00') },
    ...employeeFields<PunchRow>((p) => p.employee),
    { key: 'direction', label: 'Direction', type: 'enum', options: opts({ in: 'In', out: 'Out', unknown: 'Unknown' }), get: (p) => p.direction },
    { key: 'source', label: 'Source', type: 'enum', options: opts({ TERMINAL: 'Terminal', MOBILE: 'Mobile', CORRECTION: 'Correction', MANUAL: 'Manual' }), get: (p) => p.source },
    { key: 'outcome', label: 'Outcome', type: 'enum', options: opts({ GRANTED: 'Granted', DENIED: 'Denied', UNKNOWN: 'Unknown' }), get: (p) => p.outcome },
    { key: 'device', label: 'Device', type: 'text', get: (p) => (p.device ? p.device.name ?? p.device.serialNo : null) },
    { key: 'gate', label: 'Gate', type: 'text', get: (p) => p.device?.gateName ?? null },
    { key: 'mockLocation', label: 'Mock location', type: 'bool', get: (p) => p.isMockLocation ?? false },
    { key: 'reason', label: 'Reason', type: 'text', get: (p) => p.reason },
  ],
};

const leave: Source<LeaveRow> = {
  key: 'leave',
  label: 'Leave requests',
  description: 'Leave requests overlapping the period, any status.',
  row: 'one leave request',
  maxDays: 366,
  load: (ctx) =>
    ctx.prisma.leaveRequest.findMany({
      where: { tenantId: ctx.tenantId, startDate: { lte: dbDate(ctx.to) }, endDate: { gte: dbDate(ctx.from) }, employee: employeeFilter(ctx) },
      include: { employee: { include: EMP_INCLUDE }, leaveType: true },
      orderBy: { startDate: 'asc' },
    }),
  fields: [
    ...employeeFields<LeaveRow>((l) => l.employee),
    { key: 'leaveType', label: 'Leave type', type: 'text', get: (l) => l.leaveType.name },
    { key: 'paid', label: 'Paid', type: 'bool', get: (l) => l.leaveType.paid },
    { key: 'startDate', label: 'From', type: 'date', get: (l) => ymdOf(l.startDate) },
    { key: 'endDate', label: 'To', type: 'date', get: (l) => ymdOf(l.endDate) },
    { key: 'month', label: 'Month', type: 'text', get: (l) => ymdOf(l.startDate).slice(0, 7) },
    { key: 'days', label: 'Days', type: 'number', get: (l) => Number(l.days) },
    { key: 'status', label: 'Status', type: 'enum', options: REQUEST, get: (l) => l.status },
    { key: 'reason', label: 'Reason', type: 'text', get: (l) => l.reason },
    { key: 'requestedOn', label: 'Requested on', type: 'date', get: (l) => ymdOf(l.createdAt) },
  ],
};

const employees: Source<EmpRef> = {
  key: 'employees',
  label: 'Employees',
  description: 'The employee directory as of the end date: headcount, joiners, exits.',
  row: 'one employee',
  maxDays: 3660,
  load: (ctx) =>
    ctx.prisma.employee.findMany({
      where: { AND: [employeeFilter(ctx), { joinedOn: { lte: dbDate(ctx.to) } }] },
      include: EMP_INCLUDE,
      orderBy: { fullName: 'asc' },
    }),
  fields: [
    ...employeeFields<EmpRef>((e) => e),
    { key: 'email', label: 'Email', type: 'text', get: (e) => e.email },
    { key: 'phone', label: 'Phone', type: 'text', get: (e) => e.phone },
    { key: 'joinedOn', label: 'Joined on', type: 'date', get: (e) => ymdOf(e.joinedOn) },
    { key: 'joinedMonth', label: 'Joined (month)', type: 'text', get: (e) => ymdOf(e.joinedOn).slice(0, 7) },
    { key: 'exitOn', label: 'Exit on', type: 'date', get: (e) => (e.exitOn ? ymdOf(e.exitOn) : null) },
    { key: 'status', label: 'Status', type: 'enum', options: opts({ ACTIVE: 'Active', EXITED: 'Exited' }), get: (e) => e.status },
    { key: 'mobilePunch', label: 'Mobile punch', type: 'enum', options: opts({ NEVER: 'Never', REMOTE_DAYS: 'Remote days', ALWAYS: 'Always' }), get: (e) => e.mobilePunch },
    { key: 'biometricConsent', label: 'Biometric consent', type: 'bool', get: (e) => Boolean(e.biometricConsentAt) },
  ],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SOURCES: Record<string, Source<any>> = { days, punches, leave, employees };

/** What the builder UI shows; the getters stay on the server. */
export const catalogue = () =>
  Object.values(SOURCES).map(({ load, fields, ...s }) => ({ ...s, fields: fields.map(({ get, ...f }) => f) }));

// ── Spec ────────────────────────────────────────────────────────────────────

export const OPS = ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'isTrue', 'isFalse', 'empty', 'notEmpty', 'contains'] as const;
export const AGGS = ['count', 'distinct', 'sum', 'avg', 'min', 'max', 'percent'] as const;
export type Op = (typeof OPS)[number];
export type Agg = (typeof AGGS)[number];

export interface Condition { field: string; op: Op; value?: unknown }
/** A plain field column, or a calculation (`agg`) — any calculation turns the report into a summary grouped by the plain columns. */
export interface SpecColumn { field?: string; agg?: Agg; where?: Condition[]; label?: string }
export interface CustomSpec {
  source: string;
  columns: SpecColumn[];
  where?: Condition[];
  /** Split into titled sections (each with its own totals). */
  sectionBy?: string | null;
  sort?: { column: number; dir: 'asc' | 'desc' } | null;
  chart?: boolean;
  landscape?: boolean;
}

const NUMERIC: FieldType[] = ['number', 'minutes'];

/** Semantic checks the DTO can't express. Throws 400 with the first problem. */
export function validateSpec(spec: CustomSpec) {
  const src = SOURCES[spec.source];
  const bad = (msg: string) => { throw new AppError(400, 'BAD_REPORT_SPEC', msg); };
  if (!src) bad(`Unknown data source "${spec.source}"`);
  const field = (key: string | undefined, where: string) => src.fields.find((f) => f.key === key) ?? bad(`${where}: unknown field "${key}"`)!;
  const conds = (list: Condition[] = [], where: string) => list.forEach((c) => {
    const f = field(c.field, where);
    if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && ![...NUMERIC, 'date'].includes(f.type)) bad(`${where}: "${f.label}" can't be compared as a number or date`);
    if (['in', 'nin'].includes(c.op) && !Array.isArray(c.value)) bad(`${where}: "${f.label}" needs a list of values`);
  });
  if (!spec.columns.length) bad('Add at least one column');
  conds(spec.where, 'Conditions');
  spec.columns.forEach((c, i) => {
    const at = `Column ${i + 1}`;
    if (!c.agg) return void field(c.field, at);
    if (c.agg === 'percent' && !c.where?.length) bad(`${at}: a percentage needs a condition ("% of rows where …")`);
    if (['sum', 'avg', 'min', 'max', 'distinct'].includes(c.agg)) {
      const f = field(c.field, at);
      if (['sum', 'avg'].includes(c.agg) && !NUMERIC.includes(f.type)) bad(`${at}: can only ${c.agg} a number or duration`);
    }
    conds(c.where, at);
  });
  if (spec.sectionBy) field(spec.sectionBy, 'Sections');
  if (spec.sort && !spec.columns[spec.sort.column]) bad('Sort column does not exist');
}

// ── Engine ──────────────────────────────────────────────────────────────────

function test(v: Value, c: Condition): boolean {
  const s = v === null ? '' : String(v);
  const list = (Array.isArray(c.value) ? c.value : [c.value]).map(String);
  const num = (x: unknown) => (typeof v === 'number' ? Number(x) : String(x));
  switch (c.op) {
    case 'eq': return s === String(c.value ?? '');
    case 'neq': return s !== String(c.value ?? '');
    case 'in': return list.includes(s);
    case 'nin': return !list.includes(s);
    case 'gt': return v !== null && v > num(c.value);
    case 'gte': return v !== null && v >= num(c.value);
    case 'lt': return v !== null && v < num(c.value);
    case 'lte': return v !== null && v <= num(c.value);
    case 'isTrue': return v === true;
    case 'isFalse': return v !== true;
    case 'empty': return s === '';
    case 'notEmpty': return s !== '';
    case 'contains': return s.toLowerCase().includes(String(c.value ?? '').toLowerCase());
  }
}

/** Runs a validated spec against already-loaded rows. Pure, so it is table-tested. */
export function buildReport<R>(src: Source<R>, rows: R[], spec: CustomSpec): ReportData {
  const field = (key?: string) => src.fields.find((f) => f.key === key)!;
  const matches = (r: R, conds: Condition[] = []) => conds.every((c) => test(field(c.field).get(r), c));
  const all = rows.filter((r) => matches(r, spec.where));
  const summary = spec.columns.some((c) => c.agg);
  const plain = spec.columns.filter((c) => !c.agg);

  const measure = (c: SpecColumn, group: R[]): number | null => {
    const hit = group.filter((r) => matches(r, c.where));
    if (c.agg === 'count') return hit.length;
    if (c.agg === 'percent') return group.length ? (hit.length / group.length) * 100 : null;
    const vals = hit.map((r) => field(c.field).get(r)).filter((v) => v !== null && v !== '');
    if (c.agg === 'distinct') return new Set(vals.map(String)).size;
    const nums = vals.map(Number).filter((n) => !Number.isNaN(n));
    if (!nums.length) return null;
    if (c.agg === 'sum') return nums.reduce((a, b) => a + b, 0);
    if (c.agg === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
    // min/max of dates compare as strings, so keep the original value.
    const sorted = [...vals].sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0));
    return (c.agg === 'min' ? sorted[0] : sorted[sorted.length - 1]) as number;
  };
  const rawRow = (group: R[]): Value[] => spec.columns.map((c) => (c.agg ? measure(c, group) : field(c.field).get(group[0])));

  const display = (c: SpecColumn, v: Value): string | number => {
    if (v === null || v === undefined) return '';
    if (c.agg === 'percent') return `${Math.round(Number(v) * 10) / 10}%`;
    if (c.agg === 'count' || c.agg === 'distinct') return Number(v);
    const f = field(c.field);
    if (f.type === 'minutes') return hm(Math.round(Number(v)));
    if (f.type === 'bool') return v ? 'Yes' : '';
    if (f.type === 'enum') return f.options?.find((o) => o.value === String(v))?.label ?? String(v);
    if (typeof v === 'number') return Math.round(v * 100) / 100;
    return String(v);
  };
  const columns: Column[] = spec.columns.map((c, i) => {
    const f = c.field ? field(c.field) : null;
    const numeric = Boolean(c.agg && c.agg !== 'min' && c.agg !== 'max') || (f && NUMERIC.includes(f.type));
    return { key: `c${i}`, label: c.label?.trim() || defaultLabel(c, f), align: numeric ? 'right' : undefined, badge: f?.key === 'status' && !c.agg };
  });
  const toRow = (raw: Value[]) => Object.fromEntries(raw.map((v, i) => [`c${i}`, display(spec.columns[i], v)]));
  const totalsOf = (group: R[]) => summary
    ? Object.fromEntries(spec.columns.map((c, i) => [`c${i}`, c.agg ? display(c, measure(c, group)) : i === spec.columns.indexOf(plain[0]) ? 'Total' : '']))
    : undefined;

  const sort = spec.sort ?? (summary || !plain.length ? null : { column: 0, dir: 'asc' as const });
  const cmp = (a: Value[], b: Value[]) => {
    if (!sort) return 0;
    const [x, y] = [a[sort.column], b[sort.column]];
    const d = x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
    return sort.dir === 'desc' ? -d : d;
  };
  const tableOf = (group: R[]) => {
    const raws = summary
      ? [...grouped(group, (r) => JSON.stringify(plain.map((c) => field(c.field).get(r)))).values()].map(rawRow)
      : group.map((r) => rawRow([r]));
    return raws.sort(cmp);
  };

  const sectionField = spec.sectionBy ? field(spec.sectionBy) : null;
  const parts = sectionField ? [...grouped(all, (r) => String(display({ field: sectionField.key }, sectionField.get(r)) || '—'))].sort(([a], [b]) => a.localeCompare(b)) : [['', all] as const];
  const sections: Section[] = parts.map(([title, group]) => ({
    title: title || undefined,
    columns,
    rows: tableOf([...group]).map(toRow),
    totals: totalsOf([...group]),
  }));

  const aggs = spec.columns.map((c, i) => ({ c, i })).filter(({ c }) => c.agg);
  const firstNum = aggs.find(({ c }) => c.agg !== 'min' && c.agg !== 'max');
  return {
    kpis: [
      { label: 'Records', value: all.length },
      ...aggs.slice(0, 4).map(({ c, i }) => ({ label: columns[i].label, value: display(c, measure(c, all)) })),
    ],
    chart: spec.chart && summary && firstNum && plain.length
      ? {
          title: `${columns[firstNum.i].label} by ${plain.map((c) => field(c.field).label.toLowerCase()).join(' · ')}`,
          bars: tableOf(all)
            .map((raw) => ({ label: plain.map((c) => String(display(c, raw[spec.columns.indexOf(c)]))).join(' · '), value: Math.round(Number(raw[firstNum.i] ?? 0) * 10) / 10 }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 15),
        }
      : undefined,
    sections,
  };
}

const AGG_LABEL: Record<Agg, string> = { count: 'Count', distinct: 'Distinct', sum: 'Total', avg: 'Average', min: 'Earliest/min', max: 'Latest/max', percent: '%' };

function defaultLabel(c: SpecColumn, f: Field<unknown> | null): string {
  if (!c.agg) return f!.label;
  const cond = c.where?.length ? ` (${c.where.map((w) => w.field).join(', ')})` : '';
  if (c.agg === 'count') return `Count${cond}`;
  if (c.agg === 'percent') return `%${cond}`;
  return `${AGG_LABEL[c.agg]} ${f?.label.toLowerCase() ?? ''}`.trim();
}

export interface TemplateLike { id: string; name: string; description: string | null; spec: unknown }

/** A saved template as a report definition the export pipeline can run. */
export function customDefinition(t: TemplateLike): ReportDefinition {
  const spec = t.spec as CustomSpec;
  const src = SOURCES[spec.source];
  return {
    type: `custom:${t.id}`,
    title: t.name,
    description: t.description || `Custom report on ${src?.label.toLowerCase() ?? spec.source}`,
    formats: ['pdf', 'csv'],
    paper: { format: 'A4', landscape: spec.landscape ?? spec.columns.length > 7 },
    filters: ['dateFrom', 'dateTo', 'period', 'siteIds', 'departmentIds', 'projectIds', 'employeeIds'],
    maxDays: src?.maxDays ?? 31,
    custom: true,
    run: async (ctx) => {
      validateSpec(spec); // the catalogue may have changed since the template was saved
      return buildReport(src, await src.load(ctx), spec);
    },
  };
}
