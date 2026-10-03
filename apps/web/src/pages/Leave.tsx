import { Badge, Button, Callout, DataTable, DateInput, EmptyState, ListFooter, PageHeader, PillTabs, Select, Textarea, TextField } from '@iverto-org/core-ui';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Crud } from '../components/Crud';
import { clean, Decide, EmployeePicker, FormModal, Panel, Pick, useForm } from '../components/ui';
import { post, useAction, useApi, useCursor, useLeaveTypes, type LeaveType } from '../lib/api';
import { isHr, isManager, useMe } from '../lib/auth';
import { REQUEST_STATUS, StatusBadge, today } from '../lib/format';

interface LeaveRequest {
  id: string; employeeId: string; employee: { fullName: string; employeeCode: string }; leaveType: { code: string; name: string; color: string | null };
  startDate: string; endDate: string; startHalf: string | null; endHalf: string | null; days: number; reason: string | null; status: string; decisionNote: string | null;
}

const STATUS_TABS = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

export function Leave() {
  const { tab = 'requests' } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  return (
    <div className="space-y-6">
      <PillTabs label="Leave" value={tab} onChange={(t) => navigate(`/leave/${t}`)} tabs={[
        { value: 'requests', label: 'Requests' }, { value: 'balances', label: 'Balances' }, ...(isHr(me) ? [{ value: 'types', label: 'Leave types' }] : []),
      ]} />
      {tab === 'requests' && <Requests />}
      {tab === 'balances' && <BalancesPage />}
      {tab === 'types' && <LeaveTypes />}
    </div>
  );
}

function Requests() {
  const me = useMe();
  const mgr = isManager(me);
  const [status, setStatus] = useState(mgr ? 'AWAITING' : 'PENDING');
  const [applying, setApplying] = useState(false);
  const [params, setParams] = useSearchParams();
  useEffect(() => { if (params.has('apply')) { setApplying(true); setParams({}, { replace: true }); } }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useCursor<LeaveRequest>('/leave/requests', status === 'AWAITING' ? { awaitingMe: true } : status === 'ALL' ? {} : { status });
  const range = (r: LeaveRequest) => (r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}`) + (r.startHalf ? ` (${r.startHalf.toLowerCase()} half)` : '');

  return (
    <>
      <PageHeader title="Leave requests" actions={<Button leftIcon={<Plus size={16} />} onClick={() => setApplying(true)}>Apply for leave</Button>}
        filters={<PillTabs label="Status" value={status} onChange={setStatus} tabs={[
          ...(mgr ? [{ value: 'AWAITING', label: 'Awaiting me' }] : []), ...STATUS_TABS.map((s) => ({ value: s, label: REQUEST_STATUS[s].label })), { value: 'ALL', label: 'All' },
        ]} />} />
      <Panel>
        <DataTable rows={list.rows} getRowKey={(r) => r.id} loading={list.isLoading}
          empty={<EmptyState title={status === 'AWAITING' ? 'Nothing waiting for you' : 'No leave requests here'} />}
          columns={[
            { key: 'e', header: 'Employee', render: (r) => <span className="font-semibold text-fg">{r.employee.fullName}</span> },
            { key: 't', header: 'Type', render: (r) => <Badge tone="info">{r.leaveType.code} · {r.leaveType.name}</Badge> },
            { key: 'd', header: 'Dates', render: range },
            { key: 'n', header: 'Days', align: 'right', render: (r) => r.days },
            { key: 'r', header: 'Reason', render: (r) => <span className="text-fg-muted">{r.decisionNote ?? r.reason ?? ''}</span> },
            { key: 's', header: 'Status', render: (r) => <StatusBadge value={r.status} map={REQUEST_STATUS} /> },
            { key: 'a', header: '', render: (r) => (
              <Decide path="/leave/requests" id={r.id} noun="Leave request"
                canDecide={r.status === 'PENDING' && mgr && r.employeeId !== me.employeeId}
                canCancel={['PENDING', 'APPROVED'].includes(r.status) && (r.employeeId === me.employeeId || isHr(me))} />
            ) },
          ]} />
        <ListFooter count={list.rows.length} noun="requests" hasMore={Boolean(list.hasNextPage)} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
      </Panel>
      {applying && <ApplyLeave onClose={() => setApplying(false)} />}
    </>
  );
}

interface Preview { days: number; balances: { leaveYear: number; available: number; requested: number; availableAfter: number }[]; warnings: string[]; errors: string[]; canSubmit: boolean }

const PROBLEM: Record<string, string> = {
  NO_WORKING_DAYS: 'There are no working days in that range.',
  ATTACHMENT_REQUIRED: 'This leave type needs a supporting document — apply from the mobile app to attach it.',
  OVERLAPS_EXISTING_REQUEST: 'Overlaps a leave request you already have.',
  PAST_DATES: 'Includes past dates.',
};
const problem = (c: string) => PROBLEM[c] ?? (c.startsWith('INSUFFICIENT_BALANCE') ? `Not enough balance for leave year ${c.slice(-4)}.` : c.startsWith('MIN_NOTICE') ? `Needs ${c.split('_')[2]} days’ notice.` : c);

/** Server counts the days (§8.2) — the form previews first, then submits exactly what was previewed. */
function ApplyLeave({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const types = (useLeaveTypes().data ?? []).filter((t) => t.active);
  const [f, set] = useForm({ employeeId: '', leaveTypeId: '', from: today(), to: today(), startHalf: '', endHalf: '', reason: '' });
  const [preview, setPreview] = useState<{ for: string; result: Preview } | null>(null);
  const body = { ...f, employeeId: f.employeeId || undefined, startHalf: f.startHalf || undefined, endHalf: f.endHalf || undefined, reason: f.reason || undefined };
  const key = JSON.stringify(body);
  const fresh = preview?.for === key ? preview.result : null;

  const check = useAction(() => post<Preview>('/leave/requests/preview', body), { onSuccess: (r) => setPreview({ for: key, result: r }) });
  const submit = useAction(() => post('/leave/requests', body), { invalidate: ['/leave'], success: 'Leave requested', onSuccess: onClose });
  const halves = types.find((t) => t.id === f.leaveTypeId)?.allowHalfDay;
  const halfOptions = [{ value: 'FIRST', label: 'First half' }, { value: 'SECOND', label: 'Second half' }];

  return (
    <FormModal open onClose={onClose} title="Apply for leave" submitLabel={fresh?.canSubmit ? `Apply for ${fresh.days} day${fresh.days === 1 ? '' : 's'}` : 'Check days'}
      saving={check.isPending || submit.isPending} onSubmit={() => (fresh?.canSubmit ? submit.mutate() : check.mutate())}>
      {me.role !== 'EMPLOYEE' && <EmployeePicker label="Employee (leave empty for yourself)" value={f.employeeId} onChange={set('employeeId')} />}
      <Pick label="Leave type" required placeholder="Search leave types" options={types.map((t) => ({ value: t.id, label: t.name, description: t.code }))} value={f.leaveTypeId} onChange={set('leaveTypeId')} />
      <div className="grid grid-cols-2 gap-3">
        <DateInput label="From" required value={f.from} onChange={(e) => set('from')(e.target.value)} />
        <DateInput label="To" required value={f.to} onChange={(e) => set('to')(e.target.value)} />
      </div>
      {halves && (
        <div className="grid grid-cols-2 gap-3">
          <Pick label={f.from === f.to ? 'Half day' : 'First day'} placeholder="Full day" options={halfOptions} value={f.startHalf} onChange={set('startHalf')} />
          {f.from !== f.to && <Pick label="Last day" placeholder="Full day" options={halfOptions} value={f.endHalf} onChange={set('endHalf')} />}
        </div>
      )}
      <Textarea label="Reason" maxLength={1000} value={f.reason} onChange={(e) => set('reason')(e.target.value)} />
      {fresh && (
        <Callout tone={fresh.canSubmit ? (fresh.warnings.length ? 'warning' : 'success') : 'danger'} title={`${fresh.days} working day${fresh.days === 1 ? '' : 's'}`}>
          {fresh.balances.map((b) => <div key={b.leaveYear}>Leave year {b.leaveYear}: {b.available} available → {b.availableAfter} after</div>)}
          {[...fresh.errors, ...fresh.warnings].map((c) => <div key={c}>{problem(c)}</div>)}
        </Callout>
      )}
    </FormModal>
  );
}

interface BalanceRow { leaveType: { id: string; code: string; name: string }; opening: number; carriedForward: number; carriedIn: number; carriedOut: number; accrued: number; used: number; adjusted: number; lapsed: number; balance: number; pending: number; available: number }

/** Leave year = April–March, named by its starting year (§8.2). */
const currentLeaveYear = () => { const d = new Date(); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; };

function BalancesPage() {
  const me = useMe();
  const [employeeId, setEmployee] = useState('');
  return (
    <>
      <PageHeader title="Leave balances" subtitle="Every number is a sum of ledger rows — nothing is edited in place."
        filters={isManager(me) ? <div className="sm:w-80"><EmployeePicker label="Employee" value={employeeId} onChange={setEmployee} /></div> : undefined} />
      {isManager(me) && !employeeId && !me.employeeId ? <EmptyState title="Pick an employee" /> : <Balances employeeId={employeeId || undefined} />}
    </>
  );
}

export function Balances({ employeeId }: { employeeId?: string }) {
  const me = useMe();
  const [year, setYear] = useState(currentLeaveYear());
  const [adjusting, setAdjusting] = useState(false);
  const { data, isLoading } = useApi<{ employeeId: string; balances: BalanceRow[] }>('/leave/balances', { employeeId, year });
  const n = (v: number) => (v ? v : '');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2.5">
        <Select label="Leave year" containerClassName="w-full sm:w-56" value={String(year)} onChange={(e) => setYear(Number(e.target.value))}
          options={[0, 1, 2].map((i) => currentLeaveYear() - i).map((y) => ({ value: String(y), label: `Apr ${y} – Mar ${y + 1}` }))} />
        {isHr(me) && data && <Button variant="secondary" leftIcon={<SlidersHorizontal size={16} />} onClick={() => setAdjusting(true)}>Adjust balance</Button>}
      </div>
      <Panel>
        <DataTable rows={data?.balances ?? []} getRowKey={(r) => r.leaveType.id} loading={isLoading} empty={<EmptyState title="No leave types are active yet" />}
          columns={[
            { key: 't', header: 'Type', render: (r) => <span className="font-semibold text-fg">{r.leaveType.name} <span className="text-fg-subtle">({r.leaveType.code})</span></span> },
            { key: 'o', header: 'Opening', align: 'right', render: (r) => n(r.opening) },
            { key: 'cf', header: 'Carried in', align: 'right', render: (r) => n(r.carriedIn) },
            { key: 'a', header: 'Accrued', align: 'right', render: (r) => n(r.accrued) },
            { key: 'u', header: 'Used', align: 'right', render: (r) => n(r.used) },
            { key: 'adj', header: 'Adjusted', align: 'right', render: (r) => n(r.adjusted) },
            { key: 'out', header: 'Carried out / lapsed', align: 'right', render: (r) => (r.carriedOut || r.lapsed ? `${r.carriedOut} / ${r.lapsed}` : '') },
            { key: 'p', header: 'Pending', align: 'right', render: (r) => n(r.pending) },
            { key: 'av', header: 'Available', align: 'right', render: (r) => <span className="font-semibold text-fg">{r.available}</span> },
          ]} />
      </Panel>
      {adjusting && data && <Adjust employeeId={data.employeeId} year={year} onClose={() => setAdjusting(false)} />}
    </div>
  );
}

function Adjust({ employeeId, year, onClose }: { employeeId: string; year: number; onClose: () => void }) {
  const types = useLeaveTypes().data ?? [];
  const [f, set] = useForm({ leaveTypeId: '', delta: '', kind: 'ADJUSTMENT', note: '' });
  const save = useAction(() => post('/leave/adjustments', { ...f, employeeId, year, delta: Number(f.delta) }), { invalidate: ['/leave'], success: 'Balance adjusted', onSuccess: onClose });
  return (
    <FormModal open onClose={onClose} title="Adjust leave balance" description="Adds an audited ledger row." submitLabel="Add adjustment" saving={save.isPending} onSubmit={() => save.mutate()}>
      <Pick label="Leave type" required placeholder="Search leave types" options={types.map((t) => ({ value: t.id, label: t.name, description: t.code }))} value={f.leaveTypeId} onChange={set('leaveTypeId')} />
      <TextField label="Days (+/−)" type="number" step="0.5" required value={f.delta} onChange={(e) => set('delta')(e.target.value)} />
      <Pick label="Kind" required options={[{ value: 'ADJUSTMENT', label: 'Adjustment' }, { value: 'OPENING', label: 'Opening balance' }]} value={f.kind} onChange={set('kind')} />
      <Textarea label="Note" required minLength={3} maxLength={500} value={f.note} onChange={(e) => set('note')(e.target.value)} />
    </FormModal>
  );
}

function LeaveTypes() {
  return (
    <Crud<LeaveType & Record<string, any>> title="Leave types" subtitle="Quotas and rules. Removing a type deactivates it; history stays." path="/leave/types" noun="leave type"
      blank={{ code: '', name: '', color: null, paid: true, active: true, allowHalfDay: true, accrualKind: 'NONE', accrualAmount: 0, maxBalance: '', carryForwardMax: '', allowNegative: false, requiresAttachment: false, minNoticeDays: 0, countsOffDays: false, requiresHrApproval: false }}
      // Empty caps mean "no cap": send null so an edit can clear one (clean() would drop '').
      toForm={(r) => ({ ...r, maxBalance: r.maxBalance ?? '', carryForwardMax: r.carryForwardMax ?? '' })}
      toBody={(f) => clean({ ...f, maxBalance: f.maxBalance === '' ? null : f.maxBalance, carryForwardMax: f.carryForwardMax === '' ? null : f.carryForwardMax })}
      columns={[
        { key: 'code', header: 'Code', render: (r) => <span className="font-mono font-semibold">{r.code}</span> },
        { key: 'name', header: 'Name' },
        { key: 'accrual', header: 'Accrual', render: (r) => (r.accrualKind === 'NONE' ? '—' : `${r.accrualAmount} ${r.accrualKind === 'MONTHLY' ? '/ month' : '/ year'}`) },
        { key: 'cf', header: 'Carries forward', render: (r) => (r.carryForwardMax === null ? 'Everything' : Number(r.carryForwardMax) === 0 ? 'Nothing (lapses)' : `Up to ${r.carryForwardMax} days`) },
        { key: 'active', header: 'Status', render: (r) => <StatusBadge value={r.active ? 'ACTIVE' : 'INACTIVE'} map={REQUEST_STATUS} /> },
      ]}
      fields={[
        { key: 'code', label: 'Code', required: true, placeholder: 'CL' },
        { key: 'name', label: 'Name', required: true },
        { key: 'color', label: 'Colour', type: 'color' },
        { key: 'accrualKind', label: 'Accrual', type: 'select', options: [{ value: 'NONE', label: 'None' }, { value: 'MONTHLY', label: 'Monthly' }, { value: 'YEARLY_UPFRONT', label: 'Yearly, up front' }] },
        { key: 'accrualAmount', label: 'Days per accrual', type: 'number', when: (f) => f.accrualKind !== 'NONE', hint: 'Monthly credits land on the 1st, from the joining month' },
        { key: 'maxBalance', label: 'Maximum balance', type: 'number', hint: 'Empty = no cap' },
        { key: 'carryForwardMax', label: 'Carry forward to next leave year, up to', type: 'number', hint: 'At year end (1 April). Empty = everything carries, 0 = the balance lapses' },
        { key: 'minNoticeDays', label: 'Minimum notice (days)', type: 'number' },
        { key: 'paid', label: 'Paid', type: 'bool' },
        { key: 'active', label: 'Active', type: 'bool' },
        { key: 'allowHalfDay', label: 'Allow half days', type: 'bool' },
        { key: 'allowNegative', label: 'Allow negative balance', type: 'bool' },
        { key: 'requiresAttachment', label: 'Requires a document', type: 'bool' },
        { key: 'countsOffDays', label: 'Count weekly offs and holidays (sandwich rule)', type: 'bool' },
        { key: 'requiresHrApproval', label: 'HR approves after the manager', type: 'bool' },
      ]} />
  );
}

interface RemoteRequest { id: string; employeeId: string; employee?: { fullName: string }; startDate: string; endDate: string; reason: string | null; status: string; decisionNote: string | null }

export function RemoteWork() {
  const me = useMe();
  const mgr = isManager(me);
  const [status, setStatus] = useState('PENDING');
  const [adding, setAdding] = useState(false);
  const list = useCursor<RemoteRequest>('/remote-work/requests', status === 'ALL' ? {} : { status });
  const [f, set, setF] = useForm({ from: today(), to: today(), reason: '' });
  const create = useAction(() => post('/remote-work/requests', f), {
    invalidate: ['/remote-work'], success: 'Remote work requested', onSuccess: () => { setAdding(false); setF({ from: today(), to: today(), reason: '' }); },
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Remote work" subtitle="Approved days count as REMOTE and allow mobile check-in."
        actions={me.employeeId && <Button leftIcon={<Plus size={16} />} onClick={() => setAdding(true)}>Request remote work</Button>}
        filters={<PillTabs label="Status" value={status} onChange={setStatus} tabs={[...STATUS_TABS.map((s) => ({ value: s, label: REQUEST_STATUS[s].label })), { value: 'ALL', label: 'All' }]} />} />
      <Panel>
        <DataTable rows={list.rows} getRowKey={(r) => r.id} loading={list.isLoading} empty={<EmptyState title="No remote work requests here" />}
          columns={[
            { key: 'e', header: 'Employee', render: (r) => <span className="font-semibold text-fg">{r.employee?.fullName ?? '—'}</span> },
            { key: 'd', header: 'Dates', render: (r) => (r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}`) },
            { key: 'r', header: 'Reason', render: (r) => <span className="text-fg-muted">{r.decisionNote ?? r.reason ?? ''}</span> },
            { key: 's', header: 'Status', render: (r) => <StatusBadge value={r.status} map={REQUEST_STATUS} /> },
            { key: 'a', header: '', render: (r) => (
              <Decide path="/remote-work/requests" id={r.id} noun="Remote request"
                canDecide={r.status === 'PENDING' && mgr && r.employeeId !== me.employeeId}
                canCancel={['PENDING', 'APPROVED'].includes(r.status) && (r.employeeId === me.employeeId || isHr(me))} />
            ) },
          ]} />
        <ListFooter count={list.rows.length} noun="requests" hasMore={Boolean(list.hasNextPage)} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
      </Panel>
      <FormModal open={adding} onClose={() => setAdding(false)} title="Request remote work" submitLabel="Send request" saving={create.isPending} onSubmit={() => create.mutate()}>
        <div className="grid grid-cols-2 gap-3">
          <DateInput label="From" required value={f.from} onChange={(e) => set('from')(e.target.value)} />
          <DateInput label="To" required value={f.to} onChange={(e) => set('to')(e.target.value)} />
        </div>
        <Textarea label="Reason" maxLength={1000} value={f.reason} onChange={(e) => set('reason')(e.target.value)} />
      </FormModal>
    </div>
  );
}
