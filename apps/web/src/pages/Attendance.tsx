import {
  Badge, Button, Checkbox, DataTable, DateInput, EmptyState, ListFooter, PageHeader, Pagination, PillTabs, SegmentedControl, Select, Textarea, TextField, Tooltip,
} from '@iverto-org/core-ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { CorrectionModal, DayDrawer } from '../components/DayDrawer';
import { Decide, DepartmentSelect, EmployeePicker, FormModal, Panel, Pick, SiteSelect, useForm } from '../components/ui';
import { post, useAction, useApi, useCursor, type Page } from '../lib/api';
import { isHr, isManager, useMe } from '../lib/auth';
import { DAY_STATUS, hm, REQUEST_STATUS, StatusBadge, today, toOptions } from '../lib/format';
import type { Day, Punch } from '../lib/live';

const filterRow = 'flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-4';

export function Daily() {
  const me = useMe();
  const [date, setDate] = useState(today());
  const [siteId, setSite] = useState('');
  const [departmentId, setDept] = useState('');
  const [status, setStatus] = useState('');
  const [isLate, setLate] = useState(false);
  const [missedPunch, setMissed] = useState(false);
  const [page, setPage] = useState(1);
  const [dayId, setDayId] = useState<string | null>(null);
  const size = 50;
  const { data, isLoading } = useApi<Page<Day>>('/attendance/days', {
    date, siteId, departmentId, status, isLate: isLate || undefined, missedPunch: missedPunch || undefined, page, size,
  });
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  return (
    <div className="space-y-6">
      <PageHeader title="Daily status" subtitle="Attendance judged against each person’s schedule. Click a row for in/out detail."
        filters={
          <div className={filterRow}>
            <DateInput aria-label="Date" value={date} onChange={(e) => reset(setDate)(e.target.value)} className="sm:w-44" />
            {isManager(me) && <SiteSelect value={siteId} onChange={reset(setSite)} />}
            {isManager(me) && <DepartmentSelect value={departmentId} onChange={reset(setDept)} />}
            <Select hideLabel label="Status" placeholder="Any status" containerClassName="w-full sm:w-44" options={toOptions(DAY_STATUS)} value={status} onChange={(e) => reset(setStatus)(e.target.value)} />
            <Checkbox label="Late" checked={isLate} onChange={(e) => reset(setLate)(e.target.checked)} />
            <Checkbox label="Missed punch" checked={missedPunch} onChange={(e) => reset(setMissed)(e.target.checked)} />
          </div>
        } />
      <Panel>
        <DataTable rows={data?.items ?? []} getRowKey={(r) => r.id} loading={isLoading} onRowClick={(r) => setDayId(r.id)}
          empty={<EmptyState title="No attendance for this day" description="Nobody in this filter was scheduled, or the roster isn’t materialised yet." />}
          columns={[
            { key: 'employee', header: 'Employee', render: (r) => <span className="font-semibold text-fg">{r.employee?.fullName}<span className="ml-2 font-mono text-xs text-fg-subtle">{r.employee?.employeeCode}</span></span> },
            { key: 'status', header: 'Status', render: (r) => (
              <span className="flex flex-wrap gap-1.5">
                <StatusBadge value={r.status} />
                {r.isLate && <Badge tone="warning">Late</Badge>}
                {r.missedPunch && <Badge tone="danger">Missed punch</Badge>}
              </span>
            ) },
            { key: 'shift', header: 'Shift', render: (r) => (r.local.schedStart ? `${r.local.schedStart}–${r.local.schedEnd}` : r.holidayName ?? '—') },
            { key: 'in', header: 'In', render: (r) => r.local.firstIn ?? '—' },
            { key: 'out', header: 'Out', render: (r) => r.local.lastOut ?? '—' },
            { key: 'worked', header: 'Worked', align: 'right', render: (r) => hm(r.workedMinutes) },
            { key: 'ot', header: 'OT', align: 'right', render: (r) => (r.overtimeMinutes ? hm(r.overtimeMinutes) : '') },
          ]} />
      </Panel>
      {data && data.total > size && <Pagination page={page} pageCount={Math.ceil(data.total / size)} onPageChange={setPage} total={data.total} pageSize={size} noun="days" />}
      <DayDrawer dayId={dayId} onClose={() => setDayId(null)} />
    </div>
  );
}

export function Logs() {
  const me = useMe();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [siteId, setSite] = useState('');
  const [source, setSource] = useState('');
  const [unknownOnly, setUnknown] = useState(false);
  const [adding, setAdding] = useState(false);
  const logs = useCursor<Punch>('/punches', { from, to, siteId, source, unknownOnly: unknownOnly || undefined, limit: 100 });

  return (
    <div className="space-y-6">
      <PageHeader title="Daily logs" subtitle="Every raw punch, newest first. Punches are never edited — corrections are added alongside."
        actions={isHr(me) ? <Button leftIcon={<Plus size={16} />} onClick={() => setAdding(true)}>Add manual punch</Button> : undefined}
        filters={
          <div className={filterRow}>
            <DateInput label="From" value={from} onChange={(e) => setFrom(e.target.value)} className="sm:w-44" />
            <DateInput label="To" value={to} onChange={(e) => setTo(e.target.value)} className="sm:w-44" />
            {isManager(me) && <SiteSelect value={siteId} onChange={setSite} />}
            <Select hideLabel label="Source" placeholder="All sources" containerClassName="w-full sm:w-44" value={source} onChange={(e) => setSource(e.target.value)}
              options={['TERMINAL', 'MOBILE', 'CORRECTION', 'MANUAL'].map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }))} />
            {isHr(me) && <Checkbox label="Unknown slots only" checked={unknownOnly} onChange={(e) => setUnknown(e.target.checked)} />}
          </div>
        } />
      <Panel>
        <DataTable rows={logs.rows} getRowKey={(r) => r.id} loading={logs.isLoading}
          empty={<EmptyState title="No punches in this range" description="Widen the dates or clear the filters." />}
          columns={[
            { key: 'time', header: 'Time', render: (r) => <Tooltip content={`UTC${r.offset} · ${r.punchedAt}`}><span className="font-mono">{r.local}</span></Tooltip> },
            { key: 'employee', header: 'Employee', render: (r) => r.employee ? r.employee.fullName : <Badge tone="warning">Unknown slot {r.terminalUserId}</Badge> },
            { key: 'direction', header: 'Direction', render: (r) => r.direction },
            { key: 'where', header: 'Where', render: (r) => (r.device ? `${r.device.name ?? r.device.serialNo} · ${r.device.gateName}` : '—') },
            { key: 'source', header: 'Source', render: (r) => <Badge tone={r.source === 'TERMINAL' ? 'neutral' : 'info'}>{r.source.toLowerCase()}</Badge> },
            { key: 'reason', header: 'Note', render: (r) => <span className="text-fg-muted">{r.reason ?? ''}</span> },
          ]} />
        <ListFooter count={logs.rows.length} noun="punches" hasMore={Boolean(logs.hasNextPage)} loadingMore={logs.isFetchingNextPage} failed={logs.isFetchNextPageError} onLoadMore={() => void logs.fetchNextPage()} />
      </Panel>
      {adding && <ManualPunch onClose={() => setAdding(false)} />}
    </div>
  );
}

function ManualPunch({ onClose }: { onClose: () => void }) {
  const [f, set] = useForm({ employeeId: '', at: '', direction: 'in', reason: '' });
  const save = useAction(() => post('/punches', { ...f, at: new Date(f.at).toISOString() }), { invalidate: ['/punches', '/attendance', '/live'], success: 'Punch added', onSuccess: onClose });
  return (
    <FormModal open onClose={onClose} title="Add manual punch" description="Audited. Use a correction when the employee should confirm it." submitLabel="Add punch" saving={save.isPending} onSubmit={() => save.mutate()}>
      <EmployeePicker required value={f.employeeId} onChange={set('employeeId')} />
      <DateInput mode="datetime-local" label="When" hint="In your computer’s time zone" required value={f.at} onChange={(e) => set('at')(e.target.value)} />
      <Pick label="Direction" required options={[{ value: 'in', label: 'In' }, { value: 'out', label: 'Out' }]} value={f.direction} onChange={set('direction')} />
      <Textarea label="Reason" required minLength={3} maxLength={500} value={f.reason} onChange={(e) => set('reason')(e.target.value)} />
    </FormModal>
  );
}

interface Overview {
  from: string;
  to: string;
  totals: { employee: { id: string; fullName: string; employeeCode: string }; counts: Record<string, number>; lateDays: number; workedMinutes: number; overtimeMinutes: number }[];
  grid?: Record<string, Record<string, { code: string; isLate: boolean; dayId: string }>>;
}

const CODE_TONE: Record<string, string> = { P: 'bg-success-soft text-success-fg', A: 'bg-danger-soft text-danger-fg', HD: 'bg-warning-soft text-warning-fg', L: 'bg-info-soft text-info-fg', '½L': 'bg-info-soft text-info-fg', R: 'bg-brand-soft text-brand' };

export function Overview() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [siteId, setSite] = useState('');
  const [departmentId, setDept] = useState('');
  const [view, setView] = useState('grid');
  const [dayId, setDayId] = useState<string | null>(null);
  const { data, isLoading } = useApi<Overview>('/attendance/overview', { month, siteId, departmentId, grid: view === 'grid' });
  const days = data ? Array.from({ length: Number(data.to.slice(8)) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`) : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Attendance overview" subtitle="The month at a glance — the muster roll grid or per-person totals."
        filters={
          <div className={filterRow}>
            <TextField label="Month" hideLabel type="month" value={month} onChange={(e) => setMonth(e.target.value)} containerClassName="sm:w-44" />
            <SiteSelect value={siteId} onChange={setSite} />
            <DepartmentSelect value={departmentId} onChange={setDept} />
            <SegmentedControl label="View" value={view} onChange={setView} options={[{ value: 'grid', label: 'Muster grid' }, { value: 'totals', label: 'Totals' }]} />
          </div>
        } />
      {view === 'totals' ? (
        <Panel>
          <DataTable rows={data?.totals ?? []} getRowKey={(r) => r.employee.id} loading={isLoading}
            empty={<EmptyState title="No attendance this month" />}
            columns={[
              { key: 'e', header: 'Employee', render: (r) => <span className="font-semibold text-fg">{r.employee.fullName}</span> },
              ...(['PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'REMOTE', 'HOLIDAY', 'WEEKLY_OFF'] as const).map((s) => ({ key: s, header: DAY_STATUS[s].label, align: 'right' as const, render: (r: Overview['totals'][number]) => r.counts[s] || '' })),
              { key: 'late', header: 'Late', align: 'right', render: (r) => r.lateDays || '' },
              { key: 'worked', header: 'Worked', align: 'right', render: (r) => hm(r.workedMinutes) },
              { key: 'ot', header: 'OT', align: 'right', render: (r) => (r.overtimeMinutes ? hm(r.overtimeMinutes) : '') },
            ]} />
        </Panel>
      ) : (
        <Panel>
          {/* ponytail: plain CSS grid; virtualise when a single filter shows 500+ people. */}
          <div className="grid text-xs" style={{ gridTemplateColumns: `minmax(10rem, 14rem) repeat(${days.length}, minmax(2.25rem, 1fr))` }}>
            <div className="sticky left-0 bg-surface-raised px-3 py-2 font-semibold uppercase text-fg-subtle">Employee</div>
            {days.map((d) => <div key={d} className="py-2 text-center font-semibold text-fg-subtle">{Number(d.slice(8))}</div>)}
            {(data?.totals ?? []).map(({ employee: e }) => (
              <div key={e.id} className="contents">
                <div className="sticky left-0 truncate border-t border-line-soft bg-surface-raised px-3 py-1.5 font-medium text-fg">{e.fullName}</div>
                {days.map((d) => {
                  const c = data?.grid?.[e.id]?.[d];
                  return (
                    <button key={d} disabled={!c} onClick={() => c && setDayId(c.dayId)} title={c ? `${d}: ${c.code}${c.isLate ? ' (late)' : ''}` : undefined}
                      className={`m-0.5 rounded-md border-t border-line-soft py-1 text-center font-semibold ${c ? CODE_TONE[c.code] ?? 'text-fg-muted' : ''} ${c?.isLate ? 'underline decoration-warning decoration-2' : ''}`}>
                      {c?.code ?? ''}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {!isLoading && !data?.totals.length && <EmptyState title="No attendance this month" description="Try another month or filter." />}
          <p className="border-t border-line-soft px-4 py-3 text-xs text-fg-muted">P present · A absent · HD half day · L leave · ½L half leave · R remote · H holiday · WO weekly off · underlined = late</p>
        </Panel>
      )}
      <DayDrawer dayId={dayId} onClose={() => setDayId(null)} />
    </div>
  );
}

interface Correction { id: string; employee: { fullName: string; employeeCode: string }; employeeId: string; workDate: string; inAt: string | null; outAt: string | null; reason: string; status: string; decisionNote: string | null; createdAt: string }

export function Corrections() {
  const me = useMe();
  const [status, setStatus] = useState('PENDING');
  const [adding, setAdding] = useState(false);
  const list = useCursor<Correction>('/attendance/corrections', { status: status === 'ALL' ? undefined : status });
  const t = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

  return (
    <div className="space-y-6">
      <PageHeader title="Corrections" subtitle="Missed or wrong punches. Approving adds correction punches; the originals stay."
        actions={<Button leftIcon={<Plus size={16} />} onClick={() => setAdding(true)}>Request correction</Button>}
        filters={<PillTabs label="Status" value={status} onChange={setStatus} tabs={['PENDING', 'APPROVED', 'REJECTED', 'ALL'].map((s) => ({ value: s, label: s === 'ALL' ? 'All' : REQUEST_STATUS[s].label }))} />} />
      <Panel>
        <DataTable rows={list.rows} getRowKey={(r) => r.id} loading={list.isLoading}
          empty={<EmptyState title={status === 'PENDING' ? 'Nothing waiting for review' : 'No corrections here'} />}
          columns={[
            { key: 'e', header: 'Employee', render: (r) => <span className="font-semibold text-fg">{r.employee.fullName}</span> },
            { key: 'd', header: 'Day', render: (r) => r.workDate },
            { key: 'io', header: 'In / out', render: (r) => `${t(r.inAt)} / ${t(r.outAt)}` },
            { key: 'reason', header: 'Reason', render: (r) => <span className="text-fg-muted">{r.reason}</span> },
            { key: 's', header: 'Status', render: (r) => <StatusBadge value={r.status} map={REQUEST_STATUS} /> },
            { key: 'a', header: '', render: (r) => r.status === 'PENDING' && isManager(me) && r.employeeId !== me.employeeId ? <Decide path="/attendance/corrections" id={r.id} noun="Correction" canDecide /> : null },
          ]} />
        <ListFooter count={list.rows.length} noun="corrections" hasMore={Boolean(list.hasNextPage)} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
      </Panel>
      {adding && <CorrectionModal open onClose={() => setAdding(false)} />}
    </div>
  );
}
