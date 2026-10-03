import {
  AppearanceSettings, Badge, Button, Callout, Card, CenteredSpinner, CopyField, DataTable, EmptyState, IconButton, Pagination, PasswordStrength, Select, SettingsLayout, TextField, confirmAction,
} from '@iverto-org/core-ui';
import { Building2, ClipboardList, KeyRound, Layers, MapPin, Palette, Plus, Scale, ShieldCheck, Users, FolderKanban, UserX, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Crud } from '../components/Crud';
import { clean, EmployeePicker, Fields, FormModal, Panel, Pick, useForm } from '../components/ui';
import { changeOwnPassword, del, patch, post, useAction, useApi, useCalendars, useUsers, type Page, type UserProfile } from '../lib/api';
import { isHr, useMe } from '../lib/auth';
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
      { id: 'policies', label: 'Attendance policies', icon: <Scale size={18} />, description: 'Grace, thresholds, overtime' },
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

function Organisation() {
  const { data } = useApi<Org>('/org');
  if (!data) return <CenteredSpinner />;
  return <OrgForm org={data} />;
}

function OrgForm({ org }: { org: Org }) {
  const s = org.settings ?? {};
  const [f, , setF] = useForm<Record<string, any>>({
    name: org.name, dayBoundary: s.dayBoundary ?? '04:00', defaultWeeklyOffs: s.defaultWeeklyOffs ?? [0], storePunchPhotos: Boolean(s.storePunchPhotos),
    punchPhotoRetentionDays: s.punchPhotoRetentionDays ?? 90, reportRetentionDays: s.reportRetentionDays ?? 90,
    displayName: s.branding?.displayName ?? '', logoUrl: s.branding?.logoUrl ?? '', primaryColor: s.branding?.primaryColor ?? null,
  });
  const set = (k: string) => (v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = useAction(() => {
    const { displayName, logoUrl, primaryColor, ...rest } = f;
    return patch('/org', { ...rest, branding: clean({ displayName, logoUrl, primaryColor: primaryColor ?? undefined }) });
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
          { key: 'displayName', label: 'Name on reports', hint: 'Shown in the PDF header' },
          { key: 'logoUrl', label: 'Logo URL (https)', hint: 'Without one, reports use the Iverto lockup' },
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
      blank={{ name: '', address: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, holidayCalendarId: '' }}
      toForm={(s: any) => ({ ...s, address: s.address ?? '', holidayCalendarId: s.holidayCalendarId ?? '' })}
      toBody={(f) => ({ ...clean(f), holidayCalendarId: f.holidayCalendarId || null })}
      columns={[{ key: 'name', header: 'Site' }, { key: 'timezone', header: 'Timezone' }, { key: 'cal', header: 'Holidays', render: (s: any) => calendars.find((c) => c.id === s.holidayCalendarId)?.name ?? '—' }]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'address', label: 'Address' },
        { key: 'timezone', label: 'Timezone (IANA)', required: true, placeholder: 'Asia/Kolkata' },
        { key: 'holidayCalendarId', label: 'Holiday calendar', type: 'select', placeholder: 'No holidays — search calendars', hint: 'The holiday list this location follows', options: calendars.map((c) => ({ value: c.id, label: c.name })) },
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

function Policies() {
  const n = (key: string, label: string, hint?: string) => ({ key, label, hint, type: 'number' as const });
  return (
    <Crud embedded title="Attendance policies" subtitle="Changes apply from today; past days keep the policy they were judged with." path="/attendance-policies" noun="policy"
      blank={{ name: '', isDefault: false, graceInMinutes: 10, graceOutMinutes: 10, halfDayMinPercent: 50, fullDayMinPercent: 90, earlyWindowMinutes: 180, lateWindowMinutes: 360,
        duplicatePunchSeconds: 60, minSessionMinutes: 5, absentAfterMinutes: 120, missedOutCredit: 'NONE', overtimeEnabled: false, overtimeMinMinutes: 30, breakDeduction: 'SHIFT_BREAK',
        roundingMinutes: 0, minRestHours: 8, maxWeeklyHours: 60 }}
      columns={[
        { key: 'name', header: 'Policy', render: (p: any) => <span className="font-semibold text-fg">{p.name} {p.isDefault && <Badge tone="brand">Default</Badge>}</span> },
        { key: 'grace', header: 'Grace in/out', render: (p: any) => `${p.graceInMinutes} / ${p.graceOutMinutes} min` },
        { key: 'thr', header: 'Half / full day', render: (p: any) => `${p.halfDayMinPercent}% / ${p.fullDayMinPercent}%` },
        { key: 'ot', header: 'Overtime', render: (p: any) => (p.overtimeEnabled ? `after ${p.overtimeMinMinutes} min` : 'Off') },
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

interface AuditRow { id: string; action: string; actorUserId: string | null; actorType: string; targetType: string | null; targetId: string | null; payload: unknown; createdAt: string }

function Audit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const size = 50;
  const { data, isLoading } = useApi<Page<AuditRow>>('/audit-logs', { action, page, size });
  const users = useUsers().data ?? [];
  const who = (id: string | null, type: string) => users.find((u) => u.userId === id)?.displayName ?? (type === 'user' ? id?.slice(0, 8) : type);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="text-lg font-bold text-fg">Audit log</h2><p className="text-sm text-fg-muted">Append-only: every approval, correction, export and role change.</p></div>
        <TextField label="Action" hideLabel placeholder="Filter by action, e.g. LEAVE_APPROVED" value={action} onChange={(e) => { setAction(e.target.value.toUpperCase()); setPage(1); }} containerClassName="w-full sm:w-72" />
      </div>
      <Panel>
        <DataTable rows={data?.items ?? []} getRowKey={(r) => r.id} loading={isLoading} empty={<EmptyState icon={ShieldCheck} title="No audit entries match" />}
          columns={[
            { key: 't', header: 'When', render: (r) => dateTime(r.createdAt) },
            { key: 'a', header: 'Action', render: (r) => <span className="font-mono text-xs font-semibold">{r.action}</span> },
            { key: 'w', header: 'Who', render: (r) => who(r.actorUserId, r.actorType) },
            { key: 'o', header: 'On', render: (r) => (r.targetType ? `${r.targetType}${r.targetId ? ` ${r.targetId.slice(0, 8)}` : ''}` : '—') },
            { key: 'p', header: 'Detail', render: (r) => <span className="line-clamp-2 font-mono text-xs text-fg-muted">{r.payload ? JSON.stringify(r.payload) : ''}</span> },
          ]} />
      </Panel>
      {data && data.total > size && <Pagination page={page} pageCount={Math.ceil(data.total / size)} onPageChange={setPage} total={data.total} pageSize={size} noun="entries" />}
    </div>
  );
}
