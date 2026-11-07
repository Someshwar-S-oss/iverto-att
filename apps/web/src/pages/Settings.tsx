import {
  AppearanceSettings, Badge, Button, Callout, Card, CenteredSpinner, CopyField, DataTable, DescriptionList, EmptyState, IconButton, Modal, Pagination, PasswordStrength, PillTabs, Select, SettingsLayout, TextField, confirmAction,
} from '@iverto-org/core-ui';
import { Building2, ClipboardList, KeyRound, Layers, MapPin, Palette, Plus, Scale, ShieldCheck, ShieldOff, Users, FolderKanban, UserX, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Crud } from '../components/Crud';
import { clean, EmployeePicker, Fields, FormModal, Panel, Pick, useForm } from '../components/ui';
import { changeOwnPassword, DEFAULT_EMPLOYMENT_TYPES, del, patch, post, useAction, useApi, useCalendars, useDepartments, useEmployeeOptions, useLeaveTypes, useProjects, useShifts, useSites, useUsers, type Page, type UserProfile } from '../lib/api';
import { isHr, useMe } from '../lib/auth';
import { ACTION_OPTIONS, actionLabel, actionTone, auditSentence, pageOf, readableFields, SUPPORT_ACCESS, type AuditEntry, type NameOf } from '../lib/audit';
import { dateTime, REQUEST_STATUS, ROLE_LABEL, ROLES, StatusBadge } from '../lib/format';

export function Settings() {
  const me = useMe();
  const navigate = useNavigate();
  const admin = me.role === 'ADMIN';
  const hr = isHr(me);
  const sections = [
    ...(admin ? [{ id: 'organisation', label: 'Organisation', icon: <Building2 size={18} />, description: 'Name, day boundary, branding' }] : []),
    ...(hr ? [
      { id: 'sites', label: 'Sites', icon: <MapPin size={18} />, description: 'Locations and timezones' },
      { id: 'departments', label: 'Departments', icon: <Layers size={18} /> },
      { id: 'projects', label: 'Projects', icon: <FolderKanban size={18} /> },
      { id: 'policies', label: 'Attendance policies', icon: <Scale size={18} />, description: 'Grace, thresholds, overtime, late penalty' },
      { id: 'users', label: 'Users & roles', icon: <Users size={18} /> },
    ] : []),
    { id: 'password', label: 'Password', icon: <KeyRound size={18} /> },
    { id: 'appearance', label: 'Appearance', icon: <Palette size={18} /> },
    ...(admin ? [{ id: 'audit', label: 'Audit log', icon: <ClipboardList size={18} /> }] : []),
  ];
  const { section = sections[0].id } = useParams();
  return (
    <SettingsLayout sections={sections} activeId={section} onSelect={(id) => navigate(`/settings/${id}`)}>
      {section === 'organisation' && <Organisation />}
      {section === 'sites' && <Sites />}
      {section === 'departments' && <Departments />}
      {section === 'projects' && (
        <Crud embedded title="Projects" subtitle="Cross-department groupings; reports can filter by them." path="/projects" noun="project"
          blank={{ name: '', code: '', active: true }}
          columns={[{ key: 'name', header: 'Project' }, { key: 'code', header: 'Code' }, { key: 'active', header: 'Status', render: (p: any) => <StatusBadge value={p.active ? 'ACTIVE' : 'INACTIVE'} map={REQUEST_STATUS} /> }]}
          fields={[{ key: 'name', label: 'Name', required: true }, { key: 'code', label: 'Code' }, { key: 'active', label: 'Active', type: 'bool' }]} />
      )}
      {section === 'policies' && <Policies />}
      {section === 'users' && <UsersSection />}
      {section === 'password' && <ChangePassword />}
      {section === 'appearance' && <Card><AppearanceSettings /></Card>}
      {section === 'audit' && <Audit />}
    </SettingsLayout>
  );
}

interface Org { id: string; name: string; slug: string; settings: Record<string, any> }

/** "PERMANENT = Permanent" per line; a bare label gets a code made from it. */
const parseCategories = (text: string) =>
  text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [a, b] = l.includes('=') ? l.split('=').map((x) => x.trim()) : [l, l];
    return { code: a.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20), label: b };
  });

function Organisation() {
  const { data } = useApi<Org>('/org');
  if (!data) return <CenteredSpinner />;
  return <OrgForm org={data} />;
}

function OrgForm({ org }: { org: Org }) {
  const s = org.settings ?? {};
  const [f, , setF] = useForm<Record<string, any>>({
    name: org.name, dayBoundary: s.dayBoundary ?? '04:00', defaultWeeklyOffs: s.defaultWeeklyOffs ?? [0], storePunchPhotos: Boolean(s.storePunchPhotos), leaveCountsAgainstAttendance: Boolean(s.leaveCountsAgainstAttendance), internsEnabled: Boolean(s.internsEnabled), remoteRequiresHrApproval: Boolean(s.remoteRequiresHrApproval),
    punchPhotoRetentionDays: s.punchPhotoRetentionDays ?? 90, reportRetentionDays: s.reportRetentionDays ?? 90,
    employmentTypes: ((s.employmentTypes?.length ? s.employmentTypes : DEFAULT_EMPLOYMENT_TYPES) as { code: string; label: string }[]).map((t) => `${t.code} = ${t.label}`).join('\n'),
    displayName: s.branding?.displayName ?? '', logoUrl: s.branding?.logoUrl ?? '', primaryColor: s.branding?.primaryColor ?? null,
  });
  const set = (k: string) => (v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = useAction(() => {
    const { displayName, logoUrl, primaryColor, employmentTypes, ...rest } = f;
    return patch('/org', { ...rest, employmentTypes: parseCategories(employmentTypes), branding: clean({ displayName, logoUrl, primaryColor: primaryColor ?? undefined }) });
  }, { invalidate: ['/org'], success: 'Organisation settings saved' });
  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Fields form={f} set={set} specs={[
          { key: 'name', label: 'Organisation name', required: true },
          { key: 'dayBoundary', label: 'Day boundary', type: 'time', hint: 'Off-day punches before this belong to the previous day. Changing it recomputes yesterday onward.' },
          { key: 'defaultWeeklyOffs', label: 'Default weekly offs', type: 'weekdays', hint: 'For new employees' },
          { key: 'storePunchPhotos', label: 'Keep punch photos', type: 'bool', hint: 'Off by default — biometric data minimisation' },
          { key: 'punchPhotoRetentionDays', label: 'Punch photo retention (days)', type: 'number', when: (x) => x.storePunchPhotos },
          { key: 'reportRetentionDays', label: 'Report file retention (days)', type: 'number' },
          { key: 'leaveCountsAgainstAttendance', label: 'Approved leave lowers attendance score', type: 'bool', hint: 'Leaderboard. Off: approved leave days are left out; unapproved absences always count.' },
          { key: 'internsEnabled', label: 'Interns', type: 'bool', hint: 'Adds an Interns view under Employees. Employees with employment type “Intern” get no leave — no leave types, balances or accruals — since they are outside payroll.' },
          { key: 'remoteRequiresHrApproval', label: 'Remote work: two-level approval', type: 'bool', hint: 'The manager approves, then HR / admin. Off = the manager’s approval is final. Leave sets this per leave type.' },
          { key: 'employmentTypes', label: 'Employee categories', type: 'textarea',
            hint: 'One per line as CODE = Label, e.g. PERMANENT = Permanent. Each leave type can give each category its own entitlement (Leave → Leave types).' },
          { key: 'displayName', label: 'Display name', hint: 'Shown beside the logo in the web and mobile apps, and in report headers' },
          { key: 'logoUrl', label: 'Logo URL (https)', hint: 'Replaces the Iverto logo in the web app, mobile app and reports. Square images look best.' },
          { key: 'primaryColor', label: 'Report accent colour', type: 'color' },
        ]} />
        <Button type="submit" loading={save.isPending}>Save settings</Button>
      </form>
    </Card>
  );
}

function Sites() {
  const calendars = useCalendars().data ?? [];
  return (
    <Crud embedded title="Sites" subtitle="Each site has its own timezone and holiday calendar." path="/sites" noun="site"
      blank={{ name: '', address: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, holidayCalendarId: '', lat: '', lng: '', geofenceRadiusM: '', geofenceStrict: false }}
      toForm={(s: any) => ({ ...s, address: s.address ?? '', holidayCalendarId: s.holidayCalendarId ?? '', lat: s.lat ?? '', lng: s.lng ?? '', geofenceRadiusM: s.geofenceRadiusM ?? '' })}
      toBody={(f) => {
        const n = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
        return { ...clean(f), holidayCalendarId: f.holidayCalendarId || null, lat: n(f.lat), lng: n(f.lng), geofenceRadiusM: n(f.geofenceRadiusM) };
      }}
      columns={[
        { key: 'name', header: 'Site' }, { key: 'timezone', header: 'Timezone' },
        { key: 'cal', header: 'Holidays', render: (s: any) => calendars.find((c) => c.id === s.holidayCalendarId)?.name ?? '—' },
        { key: 'geo', header: 'Geofence', render: (s: any) => (s.geofenceRadiusM ? `${s.geofenceRadiusM} m${s.geofenceStrict ? ' · strict' : ''}` : '—') },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'address', label: 'Address' },
        { key: 'timezone', label: 'Timezone (IANA)', required: true, placeholder: 'Asia/Kolkata' },
        { key: 'holidayCalendarId', label: 'Holiday calendar', type: 'select', placeholder: 'No holidays — search calendars', hint: 'The holiday list this location follows', options: calendars.map((c) => ({ value: c.id, label: c.name })) },
        { key: 'lat', label: 'Latitude', type: 'number', placeholder: '13.0827', hint: 'Geofence centre. In Google Maps, right-click the office → copy the coordinates' },
        { key: 'lng', label: 'Longitude', type: 'number', placeholder: '80.2707' },
        { key: 'geofenceRadiusM', label: 'Geofence radius (m)', type: 'number', placeholder: '150', hint: 'Mobile punches inside are approved automatically; outside go to a manager. Empty = no geofence' },
        { key: 'geofenceStrict', label: 'Refuse punches outside the geofence', type: 'bool', when: (f) => Boolean(f.geofenceRadiusM) },
      ]} />
  );
}

function Departments() {
  const policies = useApi<{ id: string; name: string }[]>('/attendance-policies').data ?? [];
  return (
    <Crud embedded title="Departments" subtitle="A department head sees and approves for everyone in it." path="/departments" noun="department"
      blank={{ name: '', code: '', policyId: '', headEmployeeId: '' }}
      toForm={(d: any) => ({ ...d, code: d.code ?? '', policyId: d.policyId ?? '', headEmployeeId: d.headEmployeeId ?? '' })}
      columns={[{ key: 'name', header: 'Department' }, { key: 'code', header: 'Code' }, { key: 'n', header: 'People', align: 'right', render: (d: any) => d._count?.employees ?? '' }]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'code', label: 'Code' },
        { key: 'policyId', label: 'Attendance policy', type: 'select', placeholder: 'Tenant default', options: policies.map((p) => ({ value: p.id, label: p.name })) },
        { key: 'headEmployeeId', label: 'Department head', type: 'employee' },
      ]} />
  );
}

const LATE_DEDUCTION: Record<string, string> = { HALF_DAY: '½ day', FULL_DAY: '1 day' };

function Policies() {
  const n = (key: string, label: string, hint?: string) => ({ key, label, hint, type: 'number' as const });
  return (
    <Crud embedded title="Attendance policies" subtitle="Changes apply from today; past days keep the policy they were judged with." path="/attendance-policies" noun="policy"
      blank={{ name: '', isDefault: false, graceInMinutes: 10, graceOutMinutes: 10, halfDayMinPercent: 50, fullDayMinPercent: 90, earlyWindowMinutes: 180, lateWindowMinutes: 360,
        duplicatePunchSeconds: 60, minSessionMinutes: 5, absentAfterMinutes: 120, missedOutCredit: 'NONE', overtimeEnabled: false, overtimeMinMinutes: 30, breakDeduction: 'SHIFT_BREAK',
        roundingMinutes: 0, minRestHours: 8, maxWeeklyHours: 60, lateDeduction: 'NONE', lateDeductionEvery: 2, earlyExitCountsAsLate: false, absenceDeduction: 1, pairing: 'FIRST_LAST' }}
      columns={[
        { key: 'name', header: 'Policy', render: (p: any) => <span className="font-semibold text-fg">{p.name} {p.isDefault && <Badge tone="brand">Default</Badge>}</span> },
        { key: 'grace', header: 'Grace in/out', render: (p: any) => `${p.graceInMinutes} / ${p.graceOutMinutes} min` },
        { key: 'thr', header: 'Half / full day', render: (p: any) => `${p.halfDayMinPercent}% / ${p.fullDayMinPercent}%` },
        { key: 'ot', header: 'Overtime', render: (p: any) => (p.overtimeEnabled ? `after ${p.overtimeMinMinutes} min` : 'Off') },
        { key: 'ld', header: 'Late penalty', render: (p: any) => (p.lateDeduction === 'NONE' ? 'Off' : `${LATE_DEDUCTION[p.lateDeduction]} per ${p.lateDeductionEvery} late days`) },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'isDefault', label: 'Tenant default', type: 'bool' },
        n('graceInMinutes', 'Grace in (min)', 'Late only after start + grace'),
        n('graceOutMinutes', 'Grace out (min)'),
        n('halfDayMinPercent', 'Half day at % of required'),
        n('fullDayMinPercent', 'Full day at % of required'),
        n('absentAfterMinutes', 'Mark absent after (min)', 'Live board flips not-yet-in to absent'),
        n('earlyWindowMinutes', 'Punch window opens before shift (min)'),
        n('lateWindowMinutes', 'Punch window closes after shift (min)'),
        n('duplicatePunchSeconds', 'Merge double scans within (s)'),
        n('minSessionMinutes', 'Minimum session (min)'),
        { key: 'missedOutCredit', label: 'Missing out punch', type: 'select', options: [{ value: 'NONE', label: 'No credit' }, { value: 'UNTIL_SHIFT_END', label: 'Credit until shift end' }] },
        { key: 'breakDeduction', label: 'Break deduction', type: 'select', options: [{ value: 'SHIFT_BREAK', label: 'Deduct the shift’s break' }, { value: 'NONE', label: 'None' }] },
        { key: 'overtimeEnabled', label: 'Count overtime', type: 'bool' },
        { ...n('overtimeMinMinutes', 'Overtime counts from (min)'), when: (f) => f.overtimeEnabled },
        { key: 'lateDeduction', label: 'Late penalty', type: 'select', hint: 'Deducted from monthly attendance (muster roll, leaderboard)',
          options: [{ value: 'NONE', label: 'Off' }, { value: 'HALF_DAY', label: 'Deduct half a day' }, { value: 'FULL_DAY', label: 'Deduct a full day' }] },
        { ...n('lateDeductionEvery', 'For every … late days in a month', 'e.g. half a day for every 2 → 4 late days cost a full day'), when: (f) => f.lateDeduction !== 'NONE' },
        { key: 'earlyExitCountsAsLate', label: 'Early exits count as late days', type: 'bool', when: (f) => f.lateDeduction !== 'NONE',
          hint: 'Leaving early without approved permission. With half a day for every 1, this is “unauthorised permission costs half a day”' },
        n('absenceDeduction', 'Days deducted per absent day', 'Absent without approved leave. 1 = just the day; 1.5 = the day plus a half-day penalty (muster roll)'),
        { key: 'pairing', label: 'Punches on in/out (bidirectional) terminals', type: 'select', hint: 'Directional punches (IN/OUT gates, the mobile app) always allow several sessions a day',
          options: [{ value: 'FIRST_LAST', label: 'First in, last out (one session)' }, { value: 'ALTERNATE', label: 'Alternate in / out (several sessions a day)' }] },
        n('roundingMinutes', 'Round worked time down to (min)'),
        n('minRestHours', 'Minimum rest between shifts (h)', 'Roster warning only'),
        n('maxWeeklyHours', 'Maximum weekly hours', 'Roster warning only'),
      ]} />
  );
}

function UsersSection() {
  const me = useMe();
  const { data, isLoading } = useUsers();
  const [adding, setAdding] = useState(false);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const setRole = useAction(({ id, role }: { id: string; role: string }) => patch(`/users/${id}`, { role }), { invalidate: ['/users'], success: 'Role changed — it applies at their next sign-in' });
  const deactivate = useAction((id: string) => del(`/users/${id}`), { invalidate: ['/users'], success: 'User deactivated' });
  const reactivate = useAction((id: string) => post(`/users/${id}/reactivate`), { invalidate: ['/users'], success: 'User reactivated' });
  const reset = useAction((u: UserProfile) => post<{ temporaryPassword: string }>(`/users/${u.userId}/reset-password`), { onSuccess: (r, u) => setTemp({ email: u.email, password: r.temporaryPassword }) });
  const resetMfa = useAction((id: string) => post(`/users/${id}/reset-mfa`), { success: 'Two-factor reset — they set up a new authenticator at their next sign-in' });
  const admin = me.role === 'ADMIN';
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="text-lg font-bold text-fg">Users & roles</h2><p className="text-sm text-fg-muted">One email belongs to one organisation. Employees who only scan need no login.</p></div>
        <Button leftIcon={<Plus size={16} />} onClick={() => setAdding(true)}>Add user</Button>
      </div>
      {temp && <Callout tone="success" title={`Temporary password for ${temp.email}`} onDismiss={() => setTemp(null)}><CopyField label="Shown once — they must change it at first sign-in" value={temp.password} /></Callout>}
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(u) => u.userId} loading={isLoading} empty={<EmptyState title="No users yet" />}
          columns={[
            { key: 'n', header: 'User', render: (u) => <div><div className="font-semibold text-fg">{u.displayName}</div><div className="text-xs text-fg-muted">{u.email}</div></div> },
            { key: 'r', header: 'Role', render: (u) => admin && u.userId !== me.id
              ? <Select hideLabel label="Role" value={u.role} onChange={(e) => setRole.mutate({ id: u.userId, role: e.target.value })} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
              : ROLE_LABEL[u.role] },
            { key: 's', header: 'Status', render: (u) => <span className="flex gap-1.5"><StatusBadge value={u.status} map={REQUEST_STATUS} />{u.mustChangePassword && <Badge tone="warning">Temporary password</Badge>}</span> },
          ]}
          rowActions={(u) => u.userId === me.id ? null : <>
            <IconButton label="Reset password" icon={<KeyRound size={16} />} onClick={() => reset.mutate(u)} />
            <IconButton label="Reset two-factor" icon={<ShieldOff size={16} />} onClick={async () => { if (await confirmAction({ title: `Reset two-factor for ${u.displayName}?`, message: 'Removes their authenticator app. They must set up a new one the next time they sign in on the web. Use this when they lose or replace their phone.', confirmLabel: 'Reset two-factor' })) resetMfa.mutate(u.userId); }} />
            {admin && (u.status === 'ACTIVE'
              ? <IconButton label="Deactivate" icon={<UserX size={16} />} onClick={async () => { if (await confirmAction({ title: `Deactivate ${u.displayName}?`, message: 'They are signed out and cannot sign in. Their email stays reserved.', confirmLabel: 'Deactivate user' })) deactivate.mutate(u.userId); }} />
              : <IconButton label="Reactivate" icon={<UserCheck size={16} />} onClick={() => reactivate.mutate(u.userId)} />)}
          </>} />
      </Panel>
      {adding && <AddUser onDone={(t) => { setAdding(false); setTemp(t); }} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddUser({ onDone, onClose }: { onDone: (t: { email: string; password: string }) => void; onClose: () => void }) {
  const me = useMe();
  const [f, set] = useForm({ email: '', displayName: '', role: 'EMPLOYEE', employeeId: '' });
  const save = useAction(() => post<{ email: string; temporaryPassword: string }>('/users', clean(f)), {
    invalidate: ['/users', '/employees'], onSuccess: (r) => onDone({ email: r.email, password: r.temporaryPassword }),
  });
  const roles = me.role === 'ADMIN' ? ROLES : (['EMPLOYEE', 'MANAGER'] as const);
  return (
    <FormModal open onClose={onClose} title="Add user" description="They get a temporary password to change at first sign-in." submitLabel="Create user" saving={save.isPending} onSubmit={() => save.mutate()}>
      <TextField label="Name" required value={f.displayName} onChange={(e) => set('displayName')(e.target.value)} />
      <TextField label="Email" type="email" required value={f.email} onChange={(e) => set('email')(e.target.value)} />
      <Pick label="Role" required options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} value={f.role} onChange={set('role')} />
      <EmployeePicker label="Linked employee (for their own attendance)" value={f.employeeId} onChange={set('employeeId')} />
    </FormModal>
  );
}

function ChangePassword() {
  const me = useMe();
  const [f, set, setF] = useForm({ currentPassword: '', newPassword: '' });
  const save = useAction(() => changeOwnPassword(me.email, f.currentPassword, f.newPassword), { success: 'Password changed', onSuccess: () => setF({ currentPassword: '', newPassword: '' }) });
  return (
    <Card>
      <form className="max-w-md space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <TextField label="Current password" type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => set('currentPassword')(e.target.value)} />
        <TextField label="New password" type="password" autoComplete="new-password" required minLength={10} value={f.newPassword} onChange={(e) => set('newPassword')(e.target.value)} />
        <PasswordStrength password={f.newPassword} email={me.email} />
        <Button type="submit" loading={save.isPending}>Change password</Button>
      </form>
    </Card>
  );
}

interface AuditRow extends AuditEntry { id: string }

/** One table row: a single entry, or a run of Iverto support page views folded together. */
interface AuditLine { id: string; first: AuditRow; rows: AuditRow[] }

const VIEWS = [
  { value: 'changes', label: 'Changes' },
  { value: 'support', label: 'Iverto support access' },
  { value: 'all', label: 'Everything' },
];

/** Support views by the same person less than 15 minutes apart read as one visit. */
function foldSupportViews(rows: AuditRow[]): AuditLine[] {
  const lines: AuditLine[] = [];
  for (const r of rows) {
    const last = lines[lines.length - 1];
    const view = r.action === SUPPORT_ACCESS && (r.payload as { method?: string } | null)?.method === 'GET';
    const prev = last?.rows[last.rows.length - 1];
    if (view && last?.first.action === SUPPORT_ACCESS && prev && prev.actorUserId === r.actorUserId
      && (last.first.payload as { method?: string } | null)?.method === 'GET'
      && Math.abs(Date.parse(prev.createdAt) - Date.parse(r.createdAt)) < 15 * 60_000) {
      last.rows.push(r);
    } else lines.push({ id: r.id, first: r, rows: [r] });
  }
  return lines;
}

function Audit() {
  const [page, setPage] = useState(1);
  const [view, setView] = useState('changes');
  const [action, setAction] = useState('');
  const [open, setOpen] = useState<AuditLine | null>(null);
  const size = 50;
  const query = view === 'support' ? { action: SUPPORT_ACCESS } : { ...(action ? { action } : {}), ...(view === 'changes' ? { excludeAction: SUPPORT_ACCESS } : {}) };
  const { data, isLoading } = useApi<Page<AuditRow>>('/audit-logs', { ...query, page, size });
  const nameOf = useAuditNames();
  const users = useUsers().data ?? [];
  const lines = foldSupportViews(data?.items ?? []);
  // Platform admins are not in this organisation's user list; anyone seen opening pages through support access is one.
  const support = new Set((data?.items ?? []).filter((r) => r.action === SUPPORT_ACCESS).map((r) => r.actorUserId));
  const who = (r: AuditRow) =>
    r.actorType === 'system' ? 'The system (automatic)'
      : r.actorType === 'device' ? 'An attendance terminal'
        : users.find((u) => u.userId === r.actorUserId)?.displayName ?? (support.has(r.actorUserId) ? 'Iverto support' : 'A former user');
  const sentence = (l: AuditLine) => {
    if (l.rows.length > 1) {
      const pages = [...new Set(l.rows.map((r) => pageOf((r.payload as { url?: string }).url)))];
      return `viewed ${pages.slice(0, 4).join(', ')}${pages.length > 4 ? ` and ${pages.length - 4} more` : ''}`;
    }
    return auditSentence(l.first, nameOf);
  };
  const note = (r: AuditRow) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const text = p.note ?? p.reason ?? p.decisionNote;
    return typeof text === 'string' && text ? `“${text}”` : '';
  };
  const fields = open ? readableFields(open.first.payload, nameOf, open.first.action) : [];
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-bold text-fg">Audit log</h2>
          <p className="text-sm text-fg-muted">A permanent record of who did what: approvals, corrections, settings changes, exports and sign-in changes. Click an entry for details.</p>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <PillTabs label="Show" value={view} onChange={(v) => { setView(v); setAction(''); setPage(1); }} tabs={VIEWS} />
          {view !== 'support' && (
            <div className="w-full sm:w-72">
              <Pick label="Kind of activity" placeholder="Any activity" options={ACTION_OPTIONS.filter((o) => o.value !== SUPPORT_ACCESS)} value={action} onChange={(v) => { setAction(v); setPage(1); }} />
            </div>
          )}
        </div>
        {view === 'support' && (
          <Callout tone="info" title="What is this?">Pages Iverto’s support team opened in your organisation while helping you — for example while you reported a problem. Each visit is recorded here so you can always see it.</Callout>
        )}
      </div>
      <Panel>
        <DataTable rows={lines} getRowKey={(l) => l.id} loading={isLoading} onRowClick={setOpen} empty={<EmptyState icon={ShieldCheck} title="Nothing recorded here yet" />}
          columns={[
            { key: 't', header: 'When', render: (l) => <span className="whitespace-nowrap text-fg-muted">{dateTime(l.first.createdAt)}</span> },
            { key: 'a', header: 'What happened', render: (l) => (
              <div className="space-y-1">
                <Badge tone={actionTone(l.first.action)}>{l.rows.length > 1 ? `Iverto support visit · ${l.rows.length} pages` : actionLabel(l.first.action)}</Badge>
                <div className="text-sm text-fg"><span className="font-semibold">{who(l.first)}</span> {sentence(l)}</div>
              </div>
            ) },
            { key: 'n', header: 'Note', render: (l) => <span className="line-clamp-2 text-xs text-fg-muted">{note(l.first)}</span> },
          ]} />
      </Panel>
      {data && data.total > size && <Pagination page={page} pageCount={Math.ceil(data.total / size)} onPageChange={setPage} total={data.total} pageSize={size} noun="entries" />}
      {open && (
        <Modal open onClose={() => setOpen(null)} size="lg" title={open.rows.length > 1 ? 'Iverto support visit' : actionLabel(open.first.action)}
          description={dateTime(open.first.createdAt) ?? undefined}>
          <div className="space-y-5 p-5 sm:p-6">
            <p className="text-base text-fg"><span className="font-semibold">{who(open.first)}</span> {sentence(open)}.</p>
            {open.rows.length > 1 ? (
              <DescriptionList columns={1} items={[...open.rows].reverse().map((r) => ({ term: dateTime(r.createdAt) ?? '', value: pageOf((r.payload as { url?: string }).url) }))} />
            ) : fields.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-fg">Details</h3>
                <DescriptionList columns={2} items={fields.map((f) => ({ term: f.term, value: <span className="break-words">{f.value}</span>, wide: f.value.length > 40 }))} />
              </div>
            )}
            <details className="rounded-xl border border-line">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-fg-muted">Technical details (for support)</summary>
              <div className="space-y-2 border-t border-line px-3 py-2 text-xs text-fg-secondary">
                <div>Action code: <span className="font-mono">{open.first.action}</span>{open.first.targetType && <> · Record: <span className="font-mono">{open.first.targetType} {open.first.targetId}</span></>}</div>
                <div>User id: <span className="font-mono">{open.first.actorUserId ?? open.first.actorType}</span></div>
                <pre className="max-h-72 overflow-auto font-mono">{JSON.stringify(open.rows.length > 1 ? open.rows.map((r) => r.payload) : open.first.payload, null, 2)}</pre>
              </div>
            </details>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Names for the ids audit entries carry (employees, leave types, locations, …), from lists the app already loads. */
function useAuditNames(): NameOf {
  const employees = useEmployeeOptions().data?.items ?? [];
  const users = useUsers().data ?? [];
  const lists: Record<string, { id: string; name: string }[]> = {
    employee: employees.map((e) => ({ id: e.id, name: e.fullName })),
    leaveType: (useLeaveTypes().data ?? []).map((t) => ({ id: t.id, name: t.name })),
    site: (useSites().data ?? []).map((s) => ({ id: s.id, name: s.name })),
    department: (useDepartments().data ?? []).map((d) => ({ id: d.id, name: d.name })),
    shift: (useShifts().data ?? []).map((s) => ({ id: s.id, name: s.name })),
    project: (useProjects().data ?? []).map((p) => ({ id: p.id, name: p.name })),
    calendar: (useCalendars().data ?? []).map((c) => ({ id: c.id, name: c.name })),
    user: users.map((u) => ({ id: u.userId, name: u.displayName })),
  };
  const KIND: Record<string, string> = {
    employeeId: 'employee', managerId: 'employee', headEmployeeId: 'employee', leaveTypeId: 'leaveType', siteId: 'site', departmentId: 'department',
    shiftId: 'shift', projectId: 'project', calendarId: 'calendar', holidayCalendarId: 'calendar', userId: 'user', approverId: 'user',
  };
  return (key, id) => lists[KIND[key] ?? '']?.find((x) => x.id === id)?.name;
}
