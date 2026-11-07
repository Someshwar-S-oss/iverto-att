import type { Tone } from '@iverto-org/core-ui';
import { dateTime } from './format';

/** LEAVE_APPROVED / LeaveRequest / logoUrl → "Leave approved" / "Leave request" / "Logo url". */
export const humanize = (s: string) => {
  const t = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const actionTone = (a: string): Tone =>
  /REJECT|DELET|DEACTIVAT|EXITED|SUSPEND|REMOVE|OFFBOARD|RELEASE/.test(a) ? 'danger'
    : /APPROV|CREATED|REACTIVAT|REGISTER|PROVISION|CLAIM/.test(a) ? 'success'
      : /PASSWORD|OVERRIDE|RESET|REEVALUATE/.test(a) ? 'warning' : 'neutral';

/** Payload as label/value rows; nested objects become "Branding · Logo url". */
export function auditFields(v: unknown, prefix = ''): { term: string; value: string }[] {
  if (v === null || v === undefined) return [];
  if (typeof v !== 'object' || Array.isArray(v)) return [{ term: prefix || 'Value', value: auditValue(v) }];
  return Object.entries(v).flatMap(([k, x]) => {
    const term = prefix ? `${prefix} · ${humanize(k)}` : humanize(k);
    return x && typeof x === 'object' && !Array.isArray(x) ? auditFields(x, term) : [{ term, value: auditValue(x) }];
  });
}
function auditValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? dateTime(v) : v;
  if (Array.isArray(v)) return v.length && v.every((x) => typeof x !== 'object' || x === null) ? v.map(auditValue).join(', ') : `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return `${Object.keys(v).length} fields`;
  return String(v);
}

// ── Plain-language entries ──────────────────────────────────────────────────

/** Display name for an id found in a payload (employeeId → "Pooja"), if known. */
export type NameOf = (key: string, id: string) => string | undefined;

export interface AuditEntry { action: string; actorUserId: string | null; actorType: string; targetType: string | null; targetId: string | null; payload: unknown; createdAt: string }

/** A platform (Iverto) admin opening this organisation's pages while helping out. */
export const SUPPORT_ACCESS = 'PLATFORM_TENANT_OVERRIDE';

const fmtDay = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const span = (p: Record<string, any>) =>
  typeof p.from === 'string' && typeof p.to === 'string' ? (p.from === p.to ? fmtDay(p.from) : `${fmtDay(p.from)} – ${fmtDay(p.to)}`)
    : typeof p.date === 'string' ? fmtDay(p.date) : '';

interface Ctx { emp: string; type: string; p: Record<string, any> }
const forEmp = (c: Ctx) => (c.emp ? ` for ${c.emp}` : '');
const ofEmp = (c: Ctx, thing: string) => (c.emp ? `${c.emp}’s ${thing}` : `a ${thing}`);
const when = (c: Ctx) => (span(c.p) ? ` (${span(c.p)})` : '');
const named = (c: Ctx, noun: string) => `${noun}${c.p.name ? ` “${c.p.name}”` : ''}`;
const leave = (c: Ctx) => c.type || 'leave';

/** Every action the API records: [short label, what happened, said after the person's name]. Unknown codes fall back to humanize(). */
const CATALOG: Record<string, [string, (c: Ctx) => string]> = {
  LEAVE_REQUESTED: ['Leave requested', (c) => `applied for ${leave(c)}${forEmp(c)}${when(c)}`],
  LEAVE_MANAGER_APPROVED: ['Leave approved by manager', (c) => `approved ${ofEmp(c, leave(c))} as manager and passed it to HR${when(c)}`],
  LEAVE_APPROVED: ['Leave approved', (c) => `approved ${ofEmp(c, leave(c))}${when(c)}`],
  LEAVE_REJECTED: ['Leave rejected', (c) => `rejected ${ofEmp(c, leave(c))}${when(c)}`],
  LEAVE_CANCELLED: ['Leave cancelled', (c) => `cancelled ${ofEmp(c, leave(c))}${when(c)}`],
  LEAVE_ADJUSTED: ['Leave balance adjusted', (c) => `${Number(c.p.delta) < 0 ? 'reduced' : 'added to'} ${ofEmp(c, `${leave(c)} balance`)}${c.p.delta != null ? ` by ${Math.abs(Number(c.p.delta))} day(s)` : ''}`],
  LEAVE_COMP_CREDIT: ['Comp-off credited', (c) => `credited comp-off${forEmp(c)}${when(c)}`],
  LEAVE_ENTITLEMENT_SET: ['Leave entitlement changed', (c) => `changed ${ofEmp(c, `${leave(c)} entitlement`)}${c.p.after == null ? ' back to the category default' : ` to ${c.p.after}`}`],
  LEAVE_TYPE_CREATED: ['Leave type created', (c) => `created ${named(c, 'the leave type')}`],
  LEAVE_TYPE_UPDATED: ['Leave type changed', (c) => `changed ${named(c, 'the leave type')}`],
  LEAVE_TYPE_DEACTIVATED: ['Leave type removed', () => 'removed a leave type'],
  REMOTE_REQUESTED: ['Remote work requested', (c) => `asked to work remotely${when(c)}`],
  REMOTE_MANAGER_APPROVED: ['Remote work approved by manager', (c) => `approved ${ofEmp(c, 'remote work')} as manager and passed it to HR${when(c)}`],
  REMOTE_APPROVED: ['Remote work approved', (c) => `approved ${ofEmp(c, 'remote work')}${when(c)}`],
  REMOTE_REJECTED: ['Remote work rejected', (c) => `rejected ${ofEmp(c, 'remote work')}${when(c)}`],
  REMOTE_CANCELLED: ['Remote work cancelled', (c) => `cancelled ${ofEmp(c, 'remote work')}${when(c)}`],
  MOBILE_PUNCH_APPROVED: ['App check-in approved', (c) => `approved ${ofEmp(c, 'mobile check-in')}`],
  MOBILE_PUNCH_REJECTED: ['App check-in rejected', (c) => `rejected ${ofEmp(c, 'mobile check-in')}`],
  CORRECTION_REQUESTED: ['Attendance correction requested', (c) => `asked to correct attendance${forEmp(c)}${when(c)}`],
  CORRECTION_APPROVED: ['Attendance correction approved', (c) => `approved ${ofEmp(c, 'attendance correction')}${when(c)}`],
  CORRECTION_REJECTED: ['Attendance correction rejected', (c) => `rejected ${ofEmp(c, 'attendance correction')}${when(c)}`],
  CORRECTION_CANCELLED: ['Attendance correction cancelled', (c) => `cancelled ${ofEmp(c, 'attendance correction')}`],
  PUNCH_MANUAL: ['Punch added by hand', (c) => `added a punch by hand${forEmp(c)}${c.p.reason ? ` — “${c.p.reason}”` : ''}`],
  ATTENDANCE_RECOMPUTED: ['Attendance recalculated', (c) => `recalculated ${ofEmp(c, 'attendance')}${when(c)}${c.p.before ? `: ${humanize(String(c.p.before))} → ${humanize(String(c.p.after ?? ''))}` : ''}`],
  ATTENDANCE_REEVALUATE: ['Past attendance re-checked', () => 'asked to re-check past attendance against the current rules'],
  EMPLOYEE_CREATED: ['Employee added', (c) => `added ${c.p.fullName ?? (c.emp || 'an employee')}`],
  EMPLOYEE_UPDATED: ['Employee details changed', (c) => `changed ${c.emp ? `${c.emp}’s` : 'an employee’s'} details`],
  EMPLOYEE_OFFBOARDED: ['Employee offboarded', (c) => `offboarded ${c.emp || 'an employee'}`],
  EMPLOYEES_IMPORTED: ['Employees imported', (c) => `imported ${c.p.created ?? c.p.count ?? 'several'} employees from a spreadsheet`],
  SCHEDULE_ASSIGNED: ['Shift assigned', (c) => `assigned a shift${forEmp(c)}`],
  ROSTER_OVERRIDES_SET: ['Roster changed', () => 'changed the roster for some days'],
  ROSTER_OVERRIDES_DELETED: ['Roster changes undone', () => 'removed some roster changes'],
  SHIFT_CREATED: ['Shift created', (c) => `created ${named(c, 'the shift')}`],
  SHIFT_UPDATED: ['Shift changed', (c) => `changed ${named(c, 'the shift')}`],
  SHIFT_DEACTIVATED: ['Shift removed', () => 'removed a shift'],
  PATTERN_CREATED: ['Shift rotation created', (c) => `created ${named(c, 'the shift rotation')}`],
  PATTERN_UPDATED: ['Shift rotation changed', (c) => `changed ${named(c, 'the shift rotation')}`],
  PATTERN_DELETED: ['Shift rotation removed', () => 'removed a shift rotation'],
  POLICY_CREATED: ['Attendance policy created', (c) => `created ${named(c, 'the attendance policy')}`],
  POLICY_UPDATED: ['Attendance policy changed', (c) => `changed ${named(c, 'the attendance policy')}`],
  POLICY_DELETED: ['Attendance policy removed', () => 'removed an attendance policy'],
  ORG_SETTINGS_UPDATED: ['Organisation settings changed', () => 'changed the organisation settings'],
  SITE_CREATED: ['Location added', (c) => `added ${named(c, 'the location')}`],
  SITE_UPDATED: ['Location changed', (c) => `changed ${named(c, 'the location')}`],
  SITE_DELETED: ['Location removed', () => 'removed a location'],
  DEPARTMENT_CREATED: ['Department added', (c) => `added ${named(c, 'the department')}`],
  DEPARTMENT_UPDATED: ['Department changed', (c) => `changed ${named(c, 'the department')}`],
  DEPARTMENT_DELETED: ['Department removed', () => 'removed a department'],
  PROJECT_CREATED: ['Project added', (c) => `added ${named(c, 'the project')}`],
  PROJECT_UPDATED: ['Project changed', (c) => `changed ${named(c, 'the project')}`],
  PROJECT_DELETED: ['Project removed', () => 'removed a project'],
  PROJECT_MEMBERS_SET: ['Project members changed', () => 'changed who is on a project'],
  HOLIDAY_CALENDAR_CREATED: ['Holiday calendar created', (c) => `created ${named(c, 'the holiday calendar')}`],
  HOLIDAY_CALENDAR_UPDATED: ['Holiday calendar changed', (c) => `changed ${named(c, 'the holiday calendar')}`],
  HOLIDAY_CALENDAR_DELETED: ['Holiday calendar removed', () => 'removed a holiday calendar'],
  HOLIDAY_CALENDAR_SITES_SET: ['Holiday calendar locations changed', () => 'changed which locations follow a holiday calendar'],
  HOLIDAY_ADDED: ['Holiday added', (c) => `added ${named(c, 'the holiday')}${when(c)}`],
  HOLIDAY_REMOVED: ['Holiday removed', () => 'removed a holiday'],
  HOLIDAYS_IMPORTED: ['Holidays imported', () => 'imported a list of holidays'],
  USER_CREATED: ['App access given', (c) => `gave app access to ${c.p.displayName ?? c.p.email ?? (c.emp || 'someone')}${c.p.role ? ` as ${humanize(String(c.p.role))}` : ''}`],
  USER_EXITED: ['App access removed', () => 'removed someone’s app access'],
  USER_PASSWORD_CHANGED: ['Password changed', () => 'changed their password'],
  USER_PASSWORD_RESET: ['Password reset', () => 'reset someone’s password'],
  USER_PASSWORD_RESET_BY_EMAIL: ['Password reset by email', () => 'reset their password from an email link'],
  USER_MFA_RESET: ['Two-step sign-in reset', () => 'reset someone’s two-step sign-in'],
  REPORT_EXPORTED: ['Report downloaded', (c) => `exported the ${c.p.type ? `${humanize(String(c.p.type)).toLowerCase()} ` : ''}report`],
  REPORT_TEMPLATE_CREATED: ['Custom report created', (c) => `created ${named(c, 'the custom report')}`],
  REPORT_TEMPLATE_UPDATED: ['Custom report changed', (c) => `changed ${named(c, 'the custom report')}`],
  REPORT_TEMPLATE_DELETED: ['Custom report removed', () => 'removed a custom report'],
  REPORT_SCHEDULE_CREATED: ['Report schedule created', (c) => `scheduled ${named(c, 'the report')}`],
  REPORT_SCHEDULE_UPDATED: ['Report schedule changed', (c) => `changed ${named(c, 'the report schedule')}`],
  REPORT_SCHEDULE_DELETED: ['Report schedule removed', () => 'removed a report schedule'],
  TENANT_CREATED: ['Organisation set up', () => 'set up the organisation'],
  TENANT_UPDATED: ['Organisation changed', () => 'changed the organisation'],
  TERMINAL_PROVISION: ['Attendance terminal added', (c) => `added an attendance terminal${c.p.gateName ? ` at “${c.p.gateName}”` : ''}`],
  TERMINAL_UPDATE: ['Attendance terminal changed', () => 'changed an attendance terminal'],
  TERMINAL_DELETED: ['Attendance terminal removed', () => 'removed an attendance terminal'],
  TERMINAL_REGISTER: ['Attendance terminal connected', () => 'connected an attendance terminal'],
  TERMINAL_PROVISION_USER: ['Employee added to a terminal', (c) => `added ${c.emp || 'an employee'} to an attendance terminal`],
  TERMINAL_REMOVE_USER: ['Employee removed from a terminal', (c) => `removed ${c.emp || 'an employee'} from an attendance terminal`],
  TERMINAL_OFFBOARD_USER: ['Leaver removed from terminals', (c) => `removed ${c.emp || 'a leaver'} from the attendance terminals`],
  TERMINAL_CLAIM_SLOT: ['Terminal user linked', () => 'linked a terminal user to an employee'],
  TERMINAL_RELEASE_SLOT: ['Terminal user freed', () => 'freed a terminal user slot'],
  TERMINAL_CAPTURE_TEMPLATE: ['Face captured', (c) => `captured a face${forEmp(c)} for the terminals`],
  TERMINAL_SYNC_ENROLMENT: ['Faces synced', () => 'synced enrolled faces to the terminals'],
  [SUPPORT_ACCESS]: ['Iverto support access', () => 'opened a page'],
};

/** API path segment → the page a person would recognise. */
const PAGES: Record<string, string> = {
  users: 'App users', 'audit-logs': 'Audit log', 'attendance-policies': 'Attendance policies', employees: 'Employees', projects: 'Projects',
  sites: 'Locations', departments: 'Departments', leave: 'Leave', 'remote-work': 'Remote work', attendance: 'Attendance', live: 'Live board',
  reports: 'Reports', shifts: 'Shifts', 'shift-patterns': 'Shift rotations', 'employee-schedules': 'Schedules', roster: 'Roster', schedule: 'Schedule',
  org: 'Organisation settings', terminals: 'Attendance terminals', punches: 'Punch log', 'holiday-calendars': 'Holidays', mobile: 'Mobile app',
  'field-visits': 'Field visits', corrections: 'Attendance corrections', me: 'Profile', auth: 'Sign-in',
};
/** "/v1/attendance-policies?page=2" → "Attendance policies". */
export function pageOf(url: unknown): string {
  const segs = String(url ?? '').split('?')[0].split('/').filter(Boolean);
  const seg = /^v\d+$/.test(segs[0] ?? '') ? segs[1] : segs[0];
  return seg ? (PAGES[seg] ?? humanize(seg.replaceAll('-', '_'))) : 'Home';
}
const METHOD: Record<string, string> = { GET: 'viewed', POST: 'made a change in', PATCH: 'edited something in', PUT: 'edited something in', DELETE: 'deleted something in' };

/**
 * Things done at a terminal's own keypad, recorded as `TERMINAL_<vendor action>`
 * (see adminActionCategory in the API). Matched on the verb, like the API does.
 */
const slot = (p: Record<string, any>) => (Number(p.terminalUserId) > 0 ? `terminal user ${p.terminalUserId}` : 'a user');
const KEYPAD: [RegExp, string, (p: Record<string, any>) => string][] = [
  [/^ENTERMENU/, 'Terminal menu opened', () => 'had its admin menu opened at the keypad'],
  [/^EXITMENU/, 'Terminal menu closed', () => 'had its admin menu closed at the keypad'],
  [/^(DELETE|RESTORE$)/, 'Removed at a terminal', (p) => `had ${slot(p)} removed at the keypad`],
  [/^ENROLL/, 'Enrolled at a terminal', (p) => `had ${slot(p)} enrolled at the keypad`],
  [/^(SETTINGCHANGED|SETTIME|TZSET|MODIFYPERIOD)$/, 'Terminal setting changed', () => 'had a setting changed at the keypad'],
];
const isKeypad = (action: string) => action.startsWith('TERMINAL_') && !CATALOG[action];
const keypad = (action: string) => (isKeypad(action) ? KEYPAD.find(([re]) => re.test(action.slice(9))) : undefined);

/** Short label for an action code: "Leave approved". */
export const actionLabel = (action: string) => CATALOG[action]?.[0] ?? keypad(action)?.[1] ?? (isKeypad(action) ? 'Terminal keypad activity' : humanize(action));
/** Every known action, for the filter. */
export const ACTION_OPTIONS = Object.entries(CATALOG).map(([value, [label]]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));

const payloadOf = (e: AuditEntry) => (e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload) ? e.payload : {}) as Record<string, any>;

/** What happened, said after the person's name: "approved Pooja’s Casual leave (2 Dec 2026)". */
export function auditSentence(e: AuditEntry, nameOf: NameOf): string {
  const p = payloadOf(e);
  if (e.action === SUPPORT_ACCESS) return `${METHOD[String(p.method)] ?? 'opened'} ${pageOf(p.url)}`;
  if (isKeypad(e.action)) return keypad(e.action)?.[2](p) ?? `reported “${p.action ?? e.action.slice(9)}” at the keypad`;
  const empId = typeof p.employeeId === 'string' ? p.employeeId : e.targetType === 'Employee' ? e.targetId : null;
  const ctx: Ctx = {
    p,
    emp: (empId && nameOf('employeeId', empId)) || '',
    type: (typeof p.leaveTypeId === 'string' && nameOf('leaveTypeId', p.leaveTypeId)) || '',
  };
  const entry = CATALOG[e.action];
  return (entry ? entry[1](ctx) : humanize(e.action).toLowerCase()).replace(/\s+/g, ' ').trim();
}

/** Keypad events: only what a person can use; log ids, stat codes and the like stay in the technical view. */
function keypadFields(p: Record<string, any>): { term: string; value: string }[] {
  return [
    { term: 'Terminal', value: String(p.serialNo ?? '—') },
    { term: 'Time on the terminal’s clock', value: dateTime(typeof p.occurredAt === 'string' ? p.occurredAt : null) },
    ...(Number(p.terminalUserId) > 0 ? [{ term: 'Terminal user', value: String(p.terminalUserId) }] : []),
    ...(Number(p.adminId) > 0 ? [{ term: 'Done by terminal admin', value: String(p.adminId) }] : []),
  ];
}

/** Payload as readable rows: ids become names (unknown ids are left to the technical view), dates read as dates. */
export function readableFields(payload: unknown, nameOf: NameOf, action = ''): { term: string; value: string }[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return auditFields(payload);
  if (isKeypad(action)) return keypadFields(payload as Record<string, any>);
  return Object.entries(payload).flatMap(([k, v]) => {
    if (k === 'method') return [];
    if (k === 'url') return [{ term: 'Page', value: pageOf(v) }];
    if (/Id$/.test(k) && typeof v === 'string') {
      const n = nameOf(k, v);
      return n ? [{ term: humanize(k.replace(/Id$/, '')), value: n }] : [];
    }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return [{ term: humanize(k), value: fmtDay(v) }];
    return auditFields(v, humanize(k));
  });
}
