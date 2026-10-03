import {
  Badge, Breadcrumbs, Button, Callout, Card, CenteredSpinner, CopyField, DataTable, DateInput, DescriptionList, EmptyState,
  PageHeader, Pagination, PillTabs, SearchInput, Textarea,
} from '@iverto-org/core-ui';
import { KeyRound, Pencil, Plus, Upload, UserMinus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DayDrawer } from '../components/DayDrawer';
import { ImportEmployees } from '../components/ImportEmployees';
import { clean, DepartmentSelect, EmployeePicker, Fields, FormModal, Panel, Pick, SiteSelect, useForm, type FieldSpec } from '../components/ui';
import { patch, post, useAction, useApi, useDepartments, useShifts, useSites, type Page } from '../lib/api';
import { isHr, useMe } from '../lib/auth';
import { addDays, hm, REQUEST_STATUS, ROLE_LABEL, ROLES, StatusBadge, today, WEEKDAYS } from '../lib/format';
import type { Day } from '../lib/live';
import { Balances } from './Leave';

interface Employee {
  id: string; employeeCode: string; fullName: string; siteId: string; departmentId: string | null; managerId: string | null;
  email: string | null; phone: string | null; designation: string | null; employmentType: string; joinedOn: string; exitOn: string | null;
  mobilePunch: string; status: string; biometricConsentAt: string | null;
  site?: { id: string; name: string }; department?: { id: string; name: string } | null; manager?: { id: string; fullName: string } | null;
}

function useEmployeeFields(creating: boolean): FieldSpec[] {
  const sites = useSites().data ?? [];
  const departments = useDepartments().data ?? [];
  const shifts = useShifts().data ?? [];
  return [
    { key: 'fullName', label: 'Full name', required: true },
    { key: 'employeeCode', label: 'Employee code', required: true },
    { key: 'siteId', label: 'Location', type: 'select', required: true, placeholder: 'Search locations', options: sites.map((s) => ({ value: s.id, label: s.name, description: s.timezone })) },
    { key: 'departmentId', label: 'Department', type: 'select', placeholder: 'No department', options: departments.map((d) => ({ value: d.id, label: d.name })) },
    { key: 'designation', label: 'Designation' },
    { key: 'email', label: 'Email', type: 'email', hint: 'Needed only if they will sign in to the app' },
    { key: 'phone', label: 'Phone' },
    { key: 'employmentType', label: 'Employment type', type: 'select', options: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((v) => ({ value: v, label: v.replace('_', ' ').toLowerCase() })) },
    { key: 'joinedOn', label: 'Joined on', type: 'date', required: true },
    { key: 'mobilePunch', label: 'Mobile punching', type: 'select', options: [{ value: 'NEVER', label: 'Never' }, { value: 'REMOTE_DAYS', label: 'On approved remote days' }, { value: 'ALWAYS', label: 'Always (field staff)' }] },
    ...(creating ? [{ key: 'shiftId', label: 'Starting shift', type: 'select' as const, placeholder: 'Tenant default shift', options: shifts.filter((s) => s.active).map((s) => ({ value: s.id, label: `${s.name} (${s.startTime}–${s.endTime})` })) }] : []),
    { key: 'biometricConsent', label: 'Biometric consent recorded', type: 'bool', hint: 'Required before enrolling a face (DPDP Act / GDPR)' },
  ];
}

const BLANK = { fullName: '', employeeCode: '', siteId: '', departmentId: '', managerId: '', designation: '', email: '', phone: '', employmentType: 'FULL_TIME', joinedOn: today(), mobilePunch: 'NEVER', shiftId: '', biometricConsent: false };

function EmployeeForm({ employee, onClose }: { employee?: Employee; onClose: () => void }) {
  const navigate = useNavigate();
  const fields = useEmployeeFields(!employee);
  const [f, , setF] = useForm<Record<string, any>>(employee ? { ...BLANK, ...employee, biometricConsent: Boolean(employee.biometricConsentAt), departmentId: employee.departmentId ?? '', managerId: employee.managerId ?? '' } : BLANK);
  const set = (k: string) => (v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = useAction(
    () => {
      const body = clean(Object.fromEntries(Object.keys(BLANK).filter((k) => !employee || k !== 'shiftId').map((k) => [k, f[k]])));
      return employee ? patch<Employee>(`/employees/${employee.id}`, body) : post<Employee>('/employees', body);
    },
    { invalidate: ['/employees'], success: employee ? 'Employee updated' : 'Employee added', onSuccess: (e) => { onClose(); if (!employee) navigate(`/employees/${e.id}`); } },
  );
  return (
    <FormModal open size="drawer" onClose={onClose} title={employee ? 'Edit employee' : 'Add employee'} submitLabel={employee ? 'Save changes' : 'Add employee'} saving={save.isPending} onSubmit={() => save.mutate()}>
      <Fields specs={fields} form={f} set={set} />
      <EmployeePicker label="Manager" value={f.managerId} onChange={set('managerId')} />
    </FormModal>
  );
}

export function Employees() {
  const me = useMe();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [siteId, setSite] = useState('');
  const [departmentId, setDept] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<'add' | 'import' | null>(null);
  // ?add=1 / ?import=1 open a dialog (the command palette links here).
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const m = params.has('import') ? 'import' : params.has('add') ? 'add' : null;
    if (m && isHr(me)) { setModal(m); setParams({}, { replace: true }); }
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const size = 50;
  const { data, isLoading } = useApi<Page<Employee>>('/employees', { q, siteId, departmentId, status, page, size });

  return (
    <div className="space-y-6">
      <PageHeader title="Employees" subtitle={data ? `${data.total} ${status === 'ACTIVE' ? 'active' : 'exited'}` : undefined}
        actions={isHr(me) && <>
          <Button variant="secondary" leftIcon={<Upload size={16} />} onClick={() => setModal('import')}>Import CSV</Button>
          <Button leftIcon={<Plus size={16} />} onClick={() => setModal('add')}>Add employee</Button>
        </>}
        filters={
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
            <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Name, code or email" />
            <SiteSelect value={siteId} onChange={(v) => { setSite(v); setPage(1); }} />
            <DepartmentSelect value={departmentId} onChange={(v) => { setDept(v); setPage(1); }} />
            <PillTabs label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} tabs={[{ value: 'ACTIVE', label: 'Active' }, { value: 'EXITED', label: 'Exited' }]} />
          </div>
        } />
      <Panel>
        <DataTable rows={data?.items ?? []} getRowKey={(r) => r.id} loading={isLoading} onRowClick={(r) => navigate(`/employees/${r.id}`)}
          empty={<EmptyState title={q ? 'No one matches that search' : 'No employees yet'} description={isHr(me) && !q ? 'Add people one by one or import a CSV.' : undefined} />}
          columns={[
            { key: 'name', header: 'Employee', render: (r) => <div><div className="font-semibold text-fg">{r.fullName}</div><div className="font-mono text-xs text-fg-subtle">{r.employeeCode}</div></div> },
            { key: 'designation', header: 'Role', render: (r) => r.designation ?? '—' },
            { key: 'dept', header: 'Department', render: (r) => r.department?.name ?? '—' },
            { key: 'site', header: 'Site', render: (r) => r.site?.name ?? '—' },
            { key: 'manager', header: 'Manager', render: (r) => r.manager?.fullName ?? '—' },
          ]} />
      </Panel>
      {data && data.total > size && <Pagination page={page} pageCount={Math.ceil(data.total / size)} onPageChange={setPage} total={data.total} pageSize={size} noun="employees" />}
      {modal === 'add' && <EmployeeForm onClose={() => setModal(null)} />}
      {modal === 'import' && <ImportEmployees onClose={() => setModal(null)} />}
    </div>
  );
}

interface EmployeeDetail extends Employee {
  login: { userId: string; role: string; status: string; mustChangePassword: boolean } | null;
  schedules: { id: string; effectiveFrom: string; effectiveTo: string | null; shiftId: string | null; patternId: string | null; weeklyOffs: number[] }[];
  faces: { template: { updatedAt: string } | null; terminals: { terminalUserId: number; faceEnrolled: boolean; device: { name: string | null; serialNo: string; gateName: string } }[] };
}

export function EmployeeDetail() {
  const { id } = useParams();
  const me = useMe();
  const hr = isHr(me);
  const [tab, setTab] = useState('attendance');
  const [modal, setModal] = useState<'edit' | 'access' | 'offboard' | 'schedule' | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [dayId, setDayId] = useState<string | null>(null);
  const { data: e } = useApi<EmployeeDetail>(`/employees/${id}`);
  const days = useApi<Page<Day>>('/attendance/days', { employeeId: id, from: addDays(today(), -30), to: today(), size: 31 }, { enabled: tab === 'attendance' });
  const shifts = useShifts().data ?? [];
  const resetPassword = useAction(() => post<{ temporaryPassword: string }>(`/users/${e!.login!.userId}/reset-password`), { onSuccess: (r) => setTempPassword(r.temporaryPassword) });

  if (!e) return <CenteredSpinner />;
  const shiftName = (sid: string | null) => shifts.find((s) => s.id === sid)?.name ?? (sid ? 'Pattern' : '—');

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<Breadcrumbs items={[{ label: 'Employees', href: '/employees' }, { label: e.fullName }]} />} title={e.fullName}
        subtitle={`${e.employeeCode} · ${e.designation ?? 'No designation'} · ${e.site?.name ?? ''}`}
        actions={hr && e.status === 'ACTIVE' && <>
          <Button variant="secondary" leftIcon={<Pencil size={16} />} onClick={() => setModal('edit')}>Edit</Button>
          {e.login
            ? <Button variant="secondary" leftIcon={<KeyRound size={16} />} loading={resetPassword.isPending} onClick={() => resetPassword.mutate()}>Reset password</Button>
            : <Button variant="secondary" leftIcon={<KeyRound size={16} />} onClick={() => setModal('access')}>Give app access</Button>}
          <Button variant="danger" leftIcon={<UserMinus size={16} />} onClick={() => setModal('offboard')}>Offboard</Button>
        </>} />
      {e.status === 'EXITED' && <Callout tone="neutral" title={`Exited on ${e.exitOn}`} />}
      {tempPassword && (
        <Callout tone="success" title="Temporary password" onDismiss={() => setTempPassword(null)}>
          <CopyField label="Share this once — they must change it at first sign-in" value={tempPassword} />
        </Callout>
      )}
      <PillTabs label="Section" value={tab} onChange={setTab} tabs={[
        { value: 'attendance', label: 'Attendance' }, { value: 'profile', label: 'Profile' }, { value: 'leave', label: 'Leave' }, { value: 'schedule', label: 'Schedule' }, { value: 'faces', label: 'Faces' },
      ]} />

      {tab === 'profile' && (
        <Card><DescriptionList columns={3} items={[
          { term: 'Department', value: e.department?.name }, { term: 'Manager', value: e.manager?.fullName }, { term: 'Employment', value: e.employmentType.replace('_', ' ').toLowerCase() },
          { term: 'Email', value: e.email }, { term: 'Phone', value: e.phone }, { term: 'Joined', value: e.joinedOn },
          { term: 'Mobile punching', value: e.mobilePunch.replace('_', ' ').toLowerCase() }, { term: 'Biometric consent', value: e.biometricConsentAt ? `Recorded ${e.biometricConsentAt.slice(0, 10)}` : 'Not recorded' },
          { term: 'App login', value: e.login ? <span className="flex gap-2">{ROLE_LABEL[e.login.role]} <StatusBadge value={e.login.status} map={REQUEST_STATUS} /></span> : 'No login' },
        ]} /></Card>
      )}
      {tab === 'attendance' && (
        <Panel>
          <DataTable rows={days.data?.items ?? []} getRowKey={(r) => r.id} loading={days.isLoading} onRowClick={(r) => setDayId(r.id)} empty={<EmptyState title="No attendance in the last 30 days" />}
            columns={[
              { key: 'd', header: 'Day', render: (r) => r.workDate },
              { key: 's', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
              { key: 'in', header: 'In', render: (r) => r.local.firstIn ?? '—' },
              { key: 'out', header: 'Out', render: (r) => r.local.lastOut ?? '—' },
              { key: 'w', header: 'Worked', align: 'right', render: (r) => hm(r.workedMinutes) },
              { key: 'l', header: 'Late', align: 'right', render: (r) => (r.isLate ? `${r.lateMinutes} min` : '') },
            ]} />
        </Panel>
      )}
      {tab === 'leave' && <Balances employeeId={e.id} />}
      {tab === 'schedule' && (
        <div className="space-y-4">
          {hr && <Button leftIcon={<Plus size={16} />} onClick={() => setModal('schedule')}>Assign schedule</Button>}
          <Panel>
            <DataTable rows={e.schedules} getRowKey={(r) => r.id} empty={<EmptyState title="No schedule assigned" />}
              columns={[
                { key: 'from', header: 'From', render: (r) => r.effectiveFrom },
                { key: 'to', header: 'To', render: (r) => r.effectiveTo ?? 'Open-ended' },
                { key: 'shift', header: 'Shift / pattern', render: (r) => shiftName(r.shiftId ?? r.patternId) },
                { key: 'off', header: 'Weekly offs', render: (r) => r.weeklyOffs?.map((d) => WEEKDAYS[d]).join(', ') || '—' },
              ]} />
          </Panel>
        </div>
      )}
      {tab === 'faces' && (
        <Panel>
          <DataTable rows={e.faces.terminals} getRowKey={(r) => `${r.device.serialNo}:${r.terminalUserId}`}
            empty={<EmptyState title="Not on any terminal yet" description="Enrol this person from Face enrolment." />}
            columns={[
              { key: 't', header: 'Terminal', render: (r) => `${r.device.name ?? r.device.serialNo} · ${r.device.gateName}` },
              { key: 'slot', header: 'Slot', render: (r) => <span className="font-mono">{r.terminalUserId}</span> },
              { key: 'face', header: 'Face', render: (r) => <Badge tone={r.faceEnrolled ? 'success' : 'warning'}>{r.faceEnrolled ? 'Enrolled' : 'Waiting for face'}</Badge> },
            ]} />
        </Panel>
      )}

      {modal === 'edit' && <EmployeeForm employee={e} onClose={() => setModal(null)} />}
      {modal === 'access' && <GrantAccess employee={e} onDone={(p) => { setModal(null); setTempPassword(p); }} onClose={() => setModal(null)} />}
      {modal === 'offboard' && <Offboard employee={e} onClose={() => setModal(null)} />}
      {modal === 'schedule' && <AssignSchedule employeeIds={[e.id]} onClose={() => setModal(null)} />}
      <DayDrawer dayId={dayId} onClose={() => setDayId(null)} />
    </div>
  );
}

function GrantAccess({ employee, onDone, onClose }: { employee: Employee; onDone: (password: string) => void; onClose: () => void }) {
  const me = useMe();
  const [role, setRole] = useState('EMPLOYEE');
  const save = useAction(() => post<{ temporaryPassword: string }>('/users', { email: employee.email, displayName: employee.fullName, role, employeeId: employee.id }), {
    invalidate: ['/employees', '/users'],
    success: 'Login created',
    onSuccess: (r) => onDone(r.temporaryPassword),
  });
  // HR may create EMPLOYEE and MANAGER logins only (§3.3).
  const roles = me.role === 'ADMIN' ? ROLES : (['EMPLOYEE', 'MANAGER'] as const);
  return (
    <FormModal open onClose={onClose} title="Give app access" description={employee.email ? `Login email: ${employee.email}` : undefined} submitLabel="Create login" saving={save.isPending} onSubmit={() => save.mutate()}>
      {!employee.email && <Callout tone="warning" title="Add an email to this employee first" />}
      <Pick label="Role" required options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} value={role} onChange={setRole} />
    </FormModal>
  );
}

function Offboard({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const [f, set] = useForm({ exitOn: today(), reason: '' });
  const save = useAction(() => post<{ devices: { serialNo: string; status: string }[] }>(`/employees/${employee.id}/offboard`, clean(f)), {
    invalidate: ['/employees'],
    success: (r) => `Offboarded · ${r.devices.filter((d) => d.status === 'cleared').length}/${r.devices.length} terminals cleared (offline ones retry hourly)`,
    onSuccess: onClose,
  });
  return (
    <FormModal open onClose={onClose} title={`Offboard ${employee.fullName}?`} description="Removes their face from every terminal, cancels pending requests and deletes their login. Attendance history is kept."
      submitLabel="Offboard employee" saving={save.isPending} onSubmit={() => save.mutate()}>
      <DateInput label="Exit date" required value={f.exitOn} onChange={(e) => set('exitOn')(e.target.value)} />
      <Textarea label="Reason" maxLength={500} value={f.reason} onChange={(e) => set('reason')(e.target.value)} />
    </FormModal>
  );
}

export function AssignSchedule({ employeeIds, onClose }: { employeeIds: string[]; onClose: () => void }) {
  const shifts = useShifts().data ?? [];
  const patterns = useApi<{ id: string; name: string }[]>('/shift-patterns').data ?? [];
  const [f, set] = useForm({ kind: 'shift', shiftId: '', patternId: '', anchorDate: today(), weeklyOffs: [0] as number[], effectiveFrom: today(), effectiveTo: '', reevaluateHistory: false });
  const save = useAction(
    () => post('/employee-schedules', clean({
      employeeIds, effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo, reevaluateHistory: f.reevaluateHistory,
      ...(f.kind === 'shift' ? { shiftId: f.shiftId, weeklyOffs: f.weeklyOffs } : { patternId: f.patternId, anchorDate: f.anchorDate }),
    })),
    { invalidate: ['/employees', '/roster', '/attendance'], success: 'Schedule assigned', onSuccess: onClose },
  );
  return (
    <FormModal open onClose={onClose} title="Assign schedule" submitLabel="Assign" saving={save.isPending} onSubmit={() => save.mutate()}>
      <PillTabs label="Kind" value={f.kind} onChange={set('kind')} tabs={[{ value: 'shift', label: 'Fixed shift' }, { value: 'pattern', label: 'Rotation pattern' }]} />
      <Fields form={f} set={set as (k: string) => (v: any) => void} specs={[
        { key: 'shiftId', label: 'Shift', type: 'select', required: true, when: (x) => x.kind === 'shift', options: shifts.filter((s) => s.active).map((s) => ({ value: s.id, label: `${s.name} (${s.startTime}–${s.endTime})` })) },
        { key: 'weeklyOffs', label: 'Weekly offs', type: 'weekdays', when: (x) => x.kind === 'shift' },
        { key: 'patternId', label: 'Pattern', type: 'select', required: true, when: (x) => x.kind === 'pattern', options: patterns.map((p) => ({ value: p.id, label: p.name })) },
        { key: 'anchorDate', label: 'Pattern day 1 falls on', type: 'date', when: (x) => x.kind === 'pattern' },
        { key: 'effectiveFrom', label: 'Effective from', type: 'date', required: true },
        { key: 'effectiveTo', label: 'Until', type: 'date', hint: 'Leave empty for open-ended' },
        { key: 'reevaluateHistory', label: 'Re-evaluate past days', type: 'bool', hint: 'Audited. Otherwise only today and future days change.' },
      ]} />
    </FormModal>
  );
}
