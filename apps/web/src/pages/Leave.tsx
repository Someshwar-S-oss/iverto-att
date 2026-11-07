import { Badge, Button, Callout, DataTable, DateInput, DescriptionList, EmptyState, ListFooter, Modal, PageHeader, PillTabs, Select, Textarea, TextField } from '@iverto-org/core-ui';
import { ExternalLink, Plus, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Crud } from '../components/Crud';
import { ApprovalTracker, clean, Decide, EmployeePicker, FormModal, Panel, Pick, useForm, type Progress } from '../components/ui';
import { post, useAction, useApi, useCursor, useEmploymentTypes, useLeaveTypes, type LeaveType } from '../lib/api';
import { isHr, isManager, useMe } from '../lib/auth';
import { REQUEST_STATUS, StatusBadge, today } from '../lib/format';
import type { Punch } from '../lib/live';

interface LeaveRequest {
  id: string; employeeId: string; employee: { fullName: string; employeeCode: string }; leaveType: { code: string; name: string; color: string | null };
  startDate: string; endDate: string; startHalf: string | null; endHalf: string | null; startTime: string | null; endTime: string | null; hours: number | null;
  days: number; reason: string | null; status: string; decisionNote: string | null; progress: Progress;
}

/** A manager cannot decide a request already passed on to HR (two-level approval). */
const canDecideNow = (me: { role: string; employeeId: string | null }, r: { status: string; employeeId: string; progress: Progress }) =>
  r.status === 'PENDING' && r.employeeId !== me.employeeId && !(me.role === 'MANAGER' && r.progress.stage === 'HR');

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
  const [openId, setOpenId] = useState<string | null>(null);
  const open = list.rows.find((r) => r.id === openId);

  return (
    <>
      <PageHeader title="Leave requests" actions={<Button leftIcon={<Plus size={16} />} onClick={() => setApplying(true)}>Apply for leave</Button>}
        filters={<PillTabs label="Status" value={status} onChange={setStatus} tabs={[
          ...(mgr ? [{ value: 'AWAITING', label: 'Awaiting me' }] : []), ...STATUS_TABS.map((s) => ({ value: s, label: REQUEST_STATUS[s].label })), { value: 'ALL', label: 'All' },
        ]} />} />
      <Panel>
        <DataTable rows={list.rows} getRowKey={(r) => r.id} loading={list.isLoading} onRowClick={(r) => setOpenId(r.id)}
          empty={<EmptyState title={status === 'AWAITING' ? 'Nothing waiting for you' : 'No leave requests here'} />}
          columns={[
            { key: 'e', header: 'Employee', render: (r) => <span className="font-semibold text-fg">{r.employee.fullName}</span> },
            { key: 't', header: 'Type', render: (r) => <Badge tone="info">{r.leaveType.code} · {r.leaveType.name}</Badge> },
            { key: 'd', header: 'Dates', render: range },
            { key: 'n', header: 'Days / hours', align: 'right', render: (r) => (r.hours !== null ? `${r.hours} h` : r.days) },
            { key: 'r', header: 'Reason', render: (r) => <span className="text-fg-muted">{r.decisionNote ?? r.reason ?? ''}</span> },
            { key: 's', header: 'Status', render: (r) => <span className="flex items-center gap-1.5"><StatusBadge value={r.status} map={REQUEST_STATUS} />{stageText(r.progress)}</span> },
            { key: 'a', header: '', render: (r) => (
              <Decide path="/leave/requests" id={r.id} noun="Leave request"
                canDecide={mgr && canDecideNow(me, r)}
                canCancel={['PENDING', 'APPROVED'].includes(r.status) && (r.employeeId === me.employeeId || isHr(me))} />
            ) },
          ]} />
        <ListFooter count={list.rows.length} noun="requests" hasMore={Boolean(list.hasNextPage)} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
      </Panel>
      {open && (
        <Modal open onClose={() => setOpenId(null)} size="lg" title={`${open.employee.fullName} · ${open.leaveType.name}`} description={`${range(open)} · ${open.hours !== null ? `${open.hours} h` : `${open.days} day${open.days === 1 ? '' : 's'}`}`}
          footer={<Decide path="/leave/requests" id={open.id} noun="Leave request" canDecide={mgr && canDecideNow(me, open)}
            canCancel={['PENDING', 'APPROVED'].includes(open.status) && (open.employeeId === me.employeeId || isHr(me))} />}>
          <div className="space-y-5 p-5 sm:p-6">
            <ApprovalTracker progress={open.progress} />
            {open.reason && <DescriptionList columns={1} items={[{ term: 'Reason given', value: open.reason }]} />}
          </div>
        </Modal>
      )}
      {applying && <ApplyLeave onClose={() => setApplying(false)} />}
    </>
  );
}

const range = (r: { startDate: string; endDate: string; startTime?: string | null; endTime?: string | null; startHalf?: string | null }) =>
  (r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}`)
  + (r.startTime ? ` ${r.startTime}–${r.endTime}` : r.startHalf ? ` (${r.startHalf.toLowerCase()} half)` : '');

/** "with manager" / "with HR" next to a pending status. */
const stageText = (p: Progress) => (p.stage === 'MANAGER' ? <span className="text-xs text-fg-muted">with manager</span> : p.stage === 'HR' ? <span className="text-xs text-fg-muted">with HR</span> : null);

interface Quota { month: string; unit: 'DAYS' | 'HOURS'; used: number; requests: number; limit: number | null; maxRequests: number | null }
interface Preview {
  days: number; hours: number | null; balances: { leaveYear: number; available: number; requested: number; availableAfter: number }[];
  quota: Quota | null; warnings: string[]; errors: string[]; canSubmit: boolean;
}

const unitOf = (q: Quota) => (q.unit === 'HOURS' ? 'h' : 'days');
const usage = (q: Quota) => [
  q.limit !== null && `${q.used} of ${q.limit} ${unitOf(q)}`,
  q.maxRequests !== null && `${q.requests} of ${q.maxRequests} requests`,
].filter(Boolean).join(' · ');

const PROBLEM: Record<string, string> = {
  NO_WORKING_DAYS: 'There are no working days in that range.',
  ATTACHMENT_REQUIRED: 'This leave type needs a supporting document — apply from the mobile app to attach it.',
  OVERLAPS_EXISTING_REQUEST: 'Overlaps a leave request you already have.',
  PAST_DATES: 'Includes past dates.',
  NOT_ELIGIBLE: 'Not available for this employee’s category.',
  MONTHLY_LIMIT_EXCEEDED: 'Goes over this month’s limit for this type.',
  MONTHLY_REQUESTS_EXCEEDED: 'No requests of this type left this month.',
};
const problem = (c: string) => PROBLEM[c]
  ?? (c.startsWith('INSUFFICIENT_BALANCE') ? `Not enough balance for leave year ${c.slice(-4)}.`
    : c.startsWith('MIN_NOTICE') ? `Needs ${c.split('_')[2]} days’ notice.`
      : c.startsWith('ELIGIBLE_FROM_') ? `Not eligible until ${c.slice(-10)} (minimum service).` : c);

/** Server counts the days (§8.2) — the form previews first, then submits exactly what was previewed. */
function ApplyLeave({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const types = (useLeaveTypes().data ?? []).filter((t) => t.active);
  const [f, set] = useForm({ employeeId: '', leaveTypeId: '', from: today(), to: today(), startHalf: '', endHalf: '', startTime: '', endTime: '', reason: '' });
  const [preview, setPreview] = useState<{ for: string; result: Preview } | null>(null);
  const hourly = types.find((t) => t.id === f.leaveTypeId)?.unit === 'HOURS';
  const body = hourly
    ? { employeeId: f.employeeId || undefined, leaveTypeId: f.leaveTypeId, from: f.from, to: f.from, startTime: f.startTime, endTime: f.endTime, reason: f.reason || undefined }
    : { ...f, startTime: undefined, endTime: undefined, employeeId: f.employeeId || undefined, startHalf: f.startHalf || undefined, endHalf: f.endHalf || undefined, reason: f.reason || undefined };
  const key = JSON.stringify(body);
  const fresh = preview?.for === key ? preview.result : null;

  const check = useAction(() => post<Preview>('/leave/requests/preview', body), { onSuccess: (r) => setPreview({ for: key, result: r }) });
  const submit = useAction(() => post('/leave/requests', body), { invalidate: ['/leave'], success: 'Leave requested', onSuccess: onClose });
  const halves = !hourly && types.find((t) => t.id === f.leaveTypeId)?.allowHalfDay;
  const amount = fresh && (fresh.hours !== null ? `${fresh.hours} h` : `${fresh.days} day${fresh.days === 1 ? '' : 's'}`);
  const halfOptions = [{ value: 'FIRST', label: 'First half' }, { value: 'SECOND', label: 'Second half' }];

  return (
    <FormModal open onClose={onClose} title="Apply for leave" submitLabel={fresh?.canSubmit ? `Apply for ${amount}` : 'Check'}
      saving={check.isPending || submit.isPending} onSubmit={() => (fresh?.canSubmit ? submit.mutate() : check.mutate())}>
      {me.role !== 'EMPLOYEE' && <EmployeePicker label="Employee (leave empty for yourself)" value={f.employeeId} onChange={set('employeeId')} />}
      <Pick label="Leave type" required placeholder="Search leave types" options={types.map((t) => ({ value: t.id, label: t.name, description: t.code }))} value={f.leaveTypeId} onChange={set('leaveTypeId')} />
      {hourly ? (
        <div className="grid grid-cols-3 gap-3">
          <DateInput label="Date" required value={f.from} onChange={(e) => set('from')(e.target.value)} />
          <DateInput mode="time" label="From" required value={f.startTime} onChange={(e) => set('startTime')(e.target.value)} />
          <DateInput mode="time" label="To" required value={f.endTime} onChange={(e) => set('endTime')(e.target.value)} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <DateInput label="From" required value={f.from} onChange={(e) => set('from')(e.target.value)} />
          <DateInput label="To" required value={f.to} onChange={(e) => set('to')(e.target.value)} />
        </div>
      )}
      {halves && (
        <div className="grid grid-cols-2 gap-3">
          <Pick label={f.from === f.to ? 'Half day' : 'First day'} placeholder="Full day" options={halfOptions} value={f.startHalf} onChange={set('startHalf')} />
          {f.from !== f.to && <Pick label="Last day" placeholder="Full day" options={halfOptions} value={f.endHalf} onChange={set('endHalf')} />}
        </div>
      )}
      <Textarea label="Reason" maxLength={1000} value={f.reason} onChange={(e) => set('reason')(e.target.value)} />
      {fresh && (
        <Callout tone={fresh.canSubmit ? (fresh.warnings.length ? 'warning' : 'success') : 'danger'} title={fresh.hours !== null ? `${fresh.hours} hours` : `${fresh.days} working day${fresh.days === 1 ? '' : 's'}`}>
          {fresh.balances.map((b) => <div key={b.leaveYear}>Leave year {b.leaveYear}: {b.available} available → {b.availableAfter} after</div>)}
          {fresh.quota && <div>{fresh.quota.month}: {usage(fresh.quota)} used so far</div>}
          {[...fresh.errors, ...fresh.warnings].map((c) => <div key={c}>{problem(c)}</div>)}
        </Callout>
      )}
    </FormModal>
  );
}

interface BalanceRow {
  leaveType: { id: string; code: string; name: string; unit: 'DAYS' | 'HOURS'; accrualKind: string };
  entitlement: { amount: number; eligible: boolean; overridden: boolean; eligibleFrom: string };
  unlimited: boolean; quota: Quota | null;
  opening: number; carriedForward: number; carriedIn: number; carriedOut: number; accrued: number; used: number; adjusted: number; lapsed: number; balance: number; pending: number; available: number | null;
}

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
  const [entitling, setEntitling] = useState<BalanceRow | null>(null);
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
            { key: 'ent', header: 'Entitlement', render: (r) => {
              const text = !r.entitlement.eligible ? 'Not eligible' : ['MONTHLY', 'YEARLY_UPFRONT'].includes(r.leaveType.accrualKind) ? `${r.entitlement.amount} / ${r.leaveType.accrualKind === 'MONTHLY' ? 'month' : 'year'}` : r.unlimited ? 'Unlimited' : '—';
              const label = <>{text}{r.entitlement.overridden && <Badge tone="info">Own</Badge>}</>;
              return isHr(me)
                ? <button type="button" className="flex items-center gap-1.5 underline decoration-dotted" onClick={() => setEntitling(r)}>{label}</button>
                : <span className="flex items-center gap-1.5">{label}</span>;
            } },
            { key: 'o', header: 'Opening', align: 'right', render: (r) => n(r.opening) },
            { key: 'cf', header: 'Carried in', align: 'right', render: (r) => n(r.carriedIn) },
            { key: 'a', header: 'Accrued', align: 'right', render: (r) => n(r.accrued) },
            { key: 'u', header: 'Used', align: 'right', render: (r) => n(r.used) },
            { key: 'adj', header: 'Adjusted', align: 'right', render: (r) => n(r.adjusted) },
            { key: 'out', header: 'Carried out / lapsed', align: 'right', render: (r) => (r.carriedOut || r.lapsed ? `${r.carriedOut} / ${r.lapsed}` : '') },
            { key: 'p', header: 'Pending', align: 'right', render: (r) => n(r.pending) },
            { key: 'av', header: 'Available', align: 'right', render: (r) => <span className="font-semibold text-fg">{r.available ?? '—'}</span> },
            { key: 'q', header: 'This month', render: (r) => (r.quota ? <span className="text-fg-muted">{usage(r.quota)}</span> : '') },
          ]} />
      </Panel>
      {adjusting && data && <Adjust employeeId={data.employeeId} year={year} onClose={() => setAdjusting(false)} />}
      {entitling && data && <Entitlement employeeId={data.employeeId} row={entitling} onClose={() => setEntitling(null)} />}
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

/** Per-person override of the blanket policy: amount per accrual, 0 = not eligible, empty = back to the category default. */
function Entitlement({ employeeId, row, onClose }: { employeeId: string; row: BalanceRow; onClose: () => void }) {
  const [amount, setAmount] = useState(row.entitlement.overridden ? String(row.entitlement.amount) : '');
  const save = useAction(() => post('/leave/entitlements', { employeeId, leaveTypeId: row.leaveType.id, amount: amount === '' ? null : Number(amount) }),
    { invalidate: ['/leave'], success: 'Entitlement saved', onSuccess: onClose });
  const per = row.leaveType.accrualKind === 'MONTHLY' ? 'Days per month' : row.leaveType.accrualKind === 'YEARLY_UPFRONT' ? 'Days per year' : 'Amount';
  return (
    <FormModal open onClose={onClose} title={`${row.leaveType.name} for this employee`} submitLabel="Save" saving={save.isPending} onSubmit={() => save.mutate()}
      description="Overrides the policy for their category on future accruals. To change this year’s balance now, use Adjust balance.">
      <TextField label={per} type="number" step="0.5" min="0" hint="0 = not eligible · empty = use the category default" value={amount} onChange={(e) => setAmount(e.target.value)} />
    </FormModal>
  );
}

const ACCRUAL = [
  { value: 'NONE', label: 'None (manual balance)' }, { value: 'MONTHLY', label: 'Monthly' }, { value: 'YEARLY_UPFRONT', label: 'Yearly, up front' },
  { value: 'UNLIMITED', label: 'Unlimited — no balance (LOP, permission)' },
];
const accrues = (f: Record<string, any>) => ['MONTHLY', 'YEARLY_UPFRONT'].includes(f.accrualKind);
const hasBalance = (f: Record<string, any>) => f.accrualKind !== 'UNLIMITED' && f.unit !== 'HOURS';
const num = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));

function LeaveTypes() {
  const categories = useEmploymentTypes();
  const entKey = (code: string) => `ent_${code}`;
  return (
    <Crud<LeaveType & Record<string, any>> title="Leave types" subtitle="The organisation’s leave policy: who gets what, how it accrues, monthly limits. Removing a type deactivates it; history stays." path="/leave/types" noun="leave type"
      blank={{ code: '', name: '', color: null, paid: true, active: true, unit: 'DAYS', allowHalfDay: true, accrualKind: 'NONE', accrualAmount: 0, maxBalance: '', carryForwardMax: '', allowNegative: false,
        requiresAttachment: false, minNoticeDays: 0, countsOffDays: false, requiresHrApproval: false, minServiceDays: 0, maxPerMonth: '', maxRequestsPerMonth: '',
        ...Object.fromEntries(categories.map((c) => [entKey(c.code), ''])) }}
      // Empty caps mean "no cap": send null so an edit can clear one (clean() would drop '').
      toForm={(r) => ({ ...r, maxBalance: r.maxBalance ?? '', carryForwardMax: r.carryForwardMax ?? '', maxPerMonth: r.maxPerMonth ?? '', maxRequestsPerMonth: r.maxRequestsPerMonth ?? '',
        ...Object.fromEntries(categories.map((c) => [entKey(c.code), r.entitlements?.[c.code] ?? ''])) })}
      toBody={(f) => {
        const rest = Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith('ent_')));
        const entitlements = Object.fromEntries(categories.filter((c) => num(f[entKey(c.code)]) !== null).map((c) => [c.code, num(f[entKey(c.code)])]));
        return {
          ...clean(rest),
          entitlements, maxBalance: num(f.maxBalance), carryForwardMax: num(f.carryForwardMax), maxPerMonth: num(f.maxPerMonth), maxRequestsPerMonth: num(f.maxRequestsPerMonth),
          ...(f.unit === 'HOURS' ? { accrualKind: 'UNLIMITED', allowHalfDay: false } : {}),
        };
      }}
      columns={[
        { key: 'code', header: 'Code', render: (r) => <span className="font-mono font-semibold">{r.code}</span> },
        { key: 'name', header: 'Name' },
        { key: 'accrual', header: 'Entitlement', render: (r) => {
          if (r.accrualKind === 'UNLIMITED') return r.unit === 'HOURS' ? 'Hourly' : 'Unlimited';
          if (r.accrualKind === 'NONE') return '—';
          const special = Object.entries((r.entitlements ?? {}) as Record<string, number>).map(([k, v]) => `${categories.find((c) => c.code === k)?.label ?? k}: ${v === 0 ? 'none' : v}`);
          return `${r.accrualAmount} / ${r.accrualKind === 'MONTHLY' ? 'month' : 'year'}${special.length ? ` (${special.join(', ')})` : ''}`;
        } },
        { key: 'month', header: 'Monthly limit', render: (r) => [r.maxPerMonth !== null && `${r.maxPerMonth} ${r.unit === 'HOURS' ? 'h' : 'days'}`, r.maxRequestsPerMonth !== null && `${r.maxRequestsPerMonth} requests`].filter(Boolean).join(' in ') || '—' },
        { key: 'cf', header: 'Carries forward', render: (r) => (!hasBalance(r) ? '—' : r.carryForwardMax === null ? 'Everything' : Number(r.carryForwardMax) === 0 ? 'Nothing (lapses)' : `Up to ${r.carryForwardMax} days`) },
        { key: 'active', header: 'Status', render: (r) => <StatusBadge value={r.active ? 'ACTIVE' : 'INACTIVE'} map={REQUEST_STATUS} /> },
      ]}
      fields={[
        { key: 'code', label: 'Code', required: true, placeholder: 'CL' },
        { key: 'name', label: 'Name', required: true },
        { key: 'color', label: 'Colour', type: 'color' },
        { key: 'unit', label: 'Taken in', type: 'select', options: [{ value: 'DAYS', label: 'Days' }, { value: 'HOURS', label: 'Hours (permission / short leave)' }],
          hint: 'Hourly types have no balance — limit them per month below' },
        { key: 'accrualKind', label: 'Accrual', type: 'select', options: ACCRUAL, when: (f) => f.unit !== 'HOURS' },
        { key: 'accrualAmount', label: 'Days per accrual (default)', type: 'number', when: accrues, hint: 'Monthly credits land on the 1st, from the month they become eligible' },
        ...categories.map((c) => ({
          key: entKey(c.code), label: `${c.label}`, type: 'number' as const, placeholder: 'Default',
          hint: 'Days per accrual for this category · empty = the default · 0 = not eligible for this type',
        })),
        { key: 'minServiceDays', label: 'Eligible after (days of service)', type: 'number', hint: 'Probation: no accrual and no requests before joining date + this many days' },
        { key: 'maxPerMonth', label: 'Monthly limit (days, or hours for hourly types)', type: 'number', hint: 'Pending + approved per calendar month. Empty = no limit. e.g. 4 hours of permission' },
        { key: 'maxRequestsPerMonth', label: 'Requests per month, at most', type: 'number', hint: 'e.g. those 4 hours in at most 3 requests. Empty = no limit' },
        { key: 'maxBalance', label: 'Maximum balance', type: 'number', hint: 'Empty = no cap', when: hasBalance },
        { key: 'carryForwardMax', label: 'Carry forward to next leave year, up to', type: 'number', hint: 'At year end (1 April). Empty = everything carries, 0 = the balance lapses', when: hasBalance },
        { key: 'minNoticeDays', label: 'Minimum notice (days)', type: 'number' },
        { key: 'paid', label: 'Paid', type: 'bool', hint: 'Off for Leave Without Pay (LOP)' },
        { key: 'active', label: 'Active', type: 'bool' },
        { key: 'allowHalfDay', label: 'Allow half days', type: 'bool', when: (f) => f.unit !== 'HOURS' },
        { key: 'allowNegative', label: 'Allow negative balance', type: 'bool', when: hasBalance },
        { key: 'requiresAttachment', label: 'Requires a document', type: 'bool' },
        { key: 'countsOffDays', label: 'Count weekly offs and holidays (sandwich rule)', type: 'bool' },
        { key: 'requiresHrApproval', label: 'Two-level approval: manager, then HR / admin', type: 'bool', hint: 'Off = the manager’s approval is final' },
      ]} />
  );
}

interface RemoteRequest { id: string; employeeId: string; employee?: { fullName: string }; startDate: string; endDate: string; reason: string | null; status: string; decisionNote: string | null; progress: Progress }

export function RemoteWork() {
  const me = useMe();
  const mgr = isManager(me);
  const [status, setStatus] = useState(mgr ? 'AWAITING' : 'PENDING');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useCursor<RemoteRequest>('/remote-work/requests', status === 'AWAITING' ? { awaitingMe: true } : status === 'ALL' ? {} : { status });
  const open = list.rows.find((r) => r.id === openId);
  const [f, set, setF] = useForm({ from: today(), to: today(), reason: '' });
  const create = useAction(() => post('/remote-work/requests', f), {
    invalidate: ['/remote-work'], success: 'Remote work requested', onSuccess: () => { setAdding(false); setF({ from: today(), to: today(), reason: '' }); },
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Remote work" subtitle="Approved days count as REMOTE and allow mobile check-in."
        actions={me.employeeId && <Button leftIcon={<Plus size={16} />} onClick={() => setAdding(true)}>Request remote work</Button>}
        filters={<PillTabs label="Status" value={status} onChange={setStatus} tabs={[
          ...(mgr ? [{ value: 'AWAITING', label: 'Awaiting me' }] : []), ...STATUS_TABS.map((s) => ({ value: s, label: REQUEST_STATUS[s].label })), { value: 'ALL', label: 'All' },
        ]} />} />
      <Panel>
        <DataTable rows={list.rows} getRowKey={(r) => r.id} loading={list.isLoading} onRowClick={(r) => setOpenId(r.id)} empty={<EmptyState title="No remote work requests here" />}
          columns={[
            { key: 'e', header: 'Employee', render: (r) => <span className="font-semibold text-fg">{r.employee?.fullName ?? '—'}</span> },
            { key: 'd', header: 'Dates', render: (r) => (r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}`) },
            { key: 'r', header: 'Reason', render: (r) => <span className="text-fg-muted">{r.decisionNote ?? r.reason ?? ''}</span> },
            { key: 's', header: 'Status', render: (r) => <span className="flex items-center gap-1.5"><StatusBadge value={r.status} map={REQUEST_STATUS} />{stageText(r.progress)}</span> },
            { key: 'a', header: '', render: (r) => (
              <Decide path="/remote-work/requests" id={r.id} noun="Remote request"
                canDecide={mgr && canDecideNow(me, r)}
                canCancel={['PENDING', 'APPROVED'].includes(r.status) && (r.employeeId === me.employeeId || isHr(me))} />
            ) },
          ]} />
        <ListFooter count={list.rows.length} noun="requests" hasMore={Boolean(list.hasNextPage)} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
      </Panel>
      {open && (
        <Modal open onClose={() => setOpenId(null)} size="lg" title={`${open.employee?.fullName ?? 'Employee'} · remote work`} description={range(open)}
          footer={<Decide path="/remote-work/requests" id={open.id} noun="Remote request" canDecide={mgr && canDecideNow(me, open)}
            canCancel={['PENDING', 'APPROVED'].includes(open.status) && (open.employeeId === me.employeeId || isHr(me))} />}>
          <div className="space-y-5 p-5 sm:p-6">
            <ApprovalTracker progress={open.progress} />
            {open.reason && <DescriptionList columns={1} items={[{ term: 'Reason given', value: open.reason }]} />}
          </div>
        </Modal>
      )}
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

interface CheckIn extends Punch {
  lat: number; lng: number; accuracy: number | null; isMockLocation: boolean | null;
  reviewStatus: string; reviewNote: string | null; selfieUrl: string | null;
}

const REVIEW_TABS = ['PENDING', 'APPROVED', 'REJECTED'];
const where = (r: CheckIn) => `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}${r.accuracy != null ? ` ±${Math.round(r.accuracy)} m` : ''}`;

/** Mobile check-ins (selfie + GPS) waiting for a manager's eye. */
export function RemoteCheckIns() {
  const me = useMe();
  const [status, setStatus] = useState('PENDING');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useCursor<CheckIn>('/remote-work/punches', status === 'ALL' ? {} : { status });
  // Derived from the list, so the modal closes once a decision moves the row off this tab.
  const open = list.rows.find((r) => r.id === openId);
  const canDecide = (r: CheckIn) => r.reviewStatus === 'PENDING' && r.employeeId !== me.employeeId;
  return (
    <div className="space-y-6">
      <PageHeader title="Remote check-ins" subtitle="Selfie and GPS from the mobile app. A check-in counts at once; rejecting it removes it from the day."
        filters={<PillTabs label="Status" value={status} onChange={setStatus} tabs={[...REVIEW_TABS.map((s) => ({ value: s, label: REQUEST_STATUS[s].label })), { value: 'ALL', label: 'All' }]} />} />
      <Panel>
        <DataTable rows={list.rows} getRowKey={(r) => r.id} loading={list.isLoading} onRowClick={(r) => setOpenId(r.id)}
          empty={<EmptyState title={status === 'PENDING' ? 'Nothing waiting for review' : 'No check-ins here'} />}
          columns={[
            { key: 'p', header: '', render: (r) => r.selfieUrl
              ? <img src={r.selfieUrl} alt={`Selfie of ${r.employee?.fullName ?? 'employee'}`} className="size-10 rounded-full object-cover" loading="lazy" />
              : <span className="text-fg-subtle">—</span> },
            { key: 'e', header: 'Employee', render: (r) => <span className="font-semibold text-fg">{r.employee?.fullName ?? '—'}</span> },
            { key: 't', header: 'Time', render: (r) => <span>{r.local} <span className="text-fg-muted">· {r.direction === 'in' ? 'In' : 'Out'}</span></span> },
            { key: 'l', header: 'Location', render: (r) => (
              <span className="flex items-center gap-2 text-fg-muted">{where(r)}{r.isMockLocation && <Badge tone="danger">Mock location</Badge>}</span>
            ) },
            { key: 's', header: 'Status', render: (r) => <StatusBadge value={r.reviewStatus} map={REQUEST_STATUS} /> },
            { key: 'a', header: '', render: (r) => <Decide path="/remote-work/punches" id={r.id} noun="Check-in" canDecide={canDecide(r)} /> },
          ]} />
        <ListFooter count={list.rows.length} noun="check-ins" hasMore={Boolean(list.hasNextPage)} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
      </Panel>
      {open && (
        <Modal open onClose={() => setOpenId(null)} size="drawer" title={`${open.employee?.fullName ?? 'Employee'} · check-${open.direction}`}
          description={`${open.local} (UTC${open.offset})`}
          footer={<Decide path="/remote-work/punches" id={open.id} noun="Check-in" canDecide={canDecide(open)} />}>
          <div className="space-y-6 p-5 sm:p-6">
            {open.isMockLocation && <Callout tone="danger" title="Mock location reported">The phone flagged this position as coming from a location-faking app. Check before approving.</Callout>}
            <div className="grid gap-5 sm:grid-cols-[13rem_1fr]">
              {open.selfieUrl
                ? <a href={open.selfieUrl} target="_blank" rel="noreferrer"><img src={open.selfieUrl} alt={`Selfie of ${open.employee?.fullName ?? 'employee'}`} className="aspect-[3/4] w-full rounded-xl object-cover shadow-sm" /></a>
                : <Callout tone="warning" title="No selfie">Removed after the photo retention period.</Callout>}
              <DescriptionList columns={1} items={[
                { term: 'Status', value: <span className="flex flex-wrap items-center gap-2"><StatusBadge value={open.reviewStatus} map={REQUEST_STATUS} />{open.reviewNote && <span className="text-fg-muted">“{open.reviewNote}”</span>}</span> },
                { term: 'Checked', value: open.direction === 'in' ? 'In' : 'Out' },
                { term: 'Accuracy', value: open.accuracy != null ? `±${Math.round(open.accuracy)} m` : 'Not reported' },
                { term: 'GPS', value: open.isMockLocation ? <Badge tone="danger">Mock location</Badge> : 'Device location' },
              ]} />
            </div>
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Location</h3>
                <a className="inline-flex items-center gap-1 text-sm font-medium text-fg underline" href={`https://www.google.com/maps?q=${open.lat},${open.lng}`} target="_blank" rel="noreferrer">
                  Open in Google Maps <ExternalLink size={14} />
                </a>
              </div>
              <iframe title="Check-in location" className="h-[26rem] w-full rounded-xl border border-line"
                src={`https://www.openstreetmap.org/export/embed.html?bbox=${open.lng - 0.006},${open.lat - 0.004},${open.lng + 0.006},${open.lat + 0.004}&layer=mapnik&marker=${open.lat},${open.lng}`} />
              <p className="font-mono text-xs text-fg-muted">{where(open)}</p>
            </section>
          </div>
        </Modal>
      )}
    </div>
  );
}
