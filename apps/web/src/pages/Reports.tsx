import { Button, Card, Checkbox, confirmAction, DataTable, DateInput, EmptyState, IconButton, PageHeader, Pagination, PillTabs, TextField } from '@iverto-org/core-ui';
import { Download, FileSpreadsheet, FileText, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EmployeePicker, FormModal, Panel, Pick, SitePicker, useForm } from '../components/ui';
import { del, downloadExport, patch, post, useAction, useApi, useDepartments, useUsers, type Page } from '../lib/api';
import { isHr, isManager, useMe } from '../lib/auth';
import { dateTime, REQUEST_STATUS, StatusBadge, today } from '../lib/format';
import { awaitingDownload } from '../lib/live';

interface ReportType { type: string; title: string; description: string; formats: ('csv' | 'pdf')[]; filters: string[]; maxDays: number }
interface Job { id: string; type: string; format: string; status: string; rowCount: number | null; sha256: string | null; error: string | null; createdAt: string; scheduleId: string | null }
interface Schedule { id: string; name: string; type: string; format: 'csv' | 'pdf'; filters: Record<string, unknown>; cron: string; timezone: string; recipientUserIds: string[]; enabled: boolean; lastRunAt: string | null }

const PERIODS = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'last7', label: 'Last 7 days' },
  { value: 'thisMonth', label: 'This month' }, { value: 'lastMonth', label: 'Last month' },
];
const GROUPS = [{ value: 'none', label: 'No grouping' }, { value: 'department', label: 'By department' }, { value: 'project', label: 'By project' }, { value: 'site', label: 'By site' }];

export function Reports() {
  const me = useMe();
  const [tab, setTab] = useState('export');
  return (
    <div className="space-y-6">
      <PageHeader title="Reports" subtitle="CSV and PDF are generated on the server from the same data you see on screen."
        filters={<PillTabs label="Section" value={tab} onChange={setTab} tabs={[
          { value: 'export', label: 'Export' }, { value: 'history', label: 'Export history' }, ...(isManager(me) ? [{ value: 'schedules', label: 'Schedules' }] : []),
        ]} />} />
      {tab === 'export' && <ExportPanel onQueued={() => setTab('history')} />}
      {tab === 'history' && <History />}
      {tab === 'schedules' && <Schedules />}
    </div>
  );
}

function ExportPanel({ onQueued }: { onQueued: () => void }) {
  const me = useMe();
  const { data: types } = useApi<ReportType[]>('/reports/types', undefined, { staleTime: Infinity });
  const departments = useDepartments().data ?? [];
  const [type, setType] = useState('');
  const [f, set] = useForm({ dateFrom: today().slice(0, 8) + '01', dateTo: today(), siteId: '', departmentId: '', employeeId: '', groupBy: 'none' });
  const def = types?.find((t) => t.type === (type || types[0]?.type));
  const has = (k: string) => def?.filters.includes(k);

  const run = useAction((format: 'csv' | 'pdf') => post<{ jobId: string }>('/reports/exports', {
    type: def!.type,
    format,
    filters: {
      dateFrom: f.dateFrom, dateTo: f.dateTo,
      ...(f.siteId && { siteIds: [f.siteId] }), ...(f.departmentId && { departmentIds: [f.departmentId] }), ...(f.employeeId && { employeeIds: [f.employeeId] }),
      ...(has('groupBy') && { groupBy: f.groupBy }),
    },
  }), {
    invalidate: ['/reports/exports'],
    success: 'Generating — it downloads when ready',
    onSuccess: ({ jobId }) => { awaitingDownload.add(jobId); onQueued(); },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="grid gap-4 sm:grid-cols-2">
        {(types ?? []).map((t) => (
          <Card key={t.type} interactive onClick={() => setType(t.type)} className={def?.type === t.type ? 'ring-2 ring-brand' : ''}>
            <div className="flex items-start gap-3">
              <FileText className="mt-0.5 shrink-0 text-brand" size={20} />
              <div>
                <h3 className="font-bold text-fg">{t.title}</h3>
                <p className="text-sm text-fg-muted">{t.description}</p>
                <p className="mt-1 text-xs text-fg-subtle">{t.formats.map((x) => x.toUpperCase()).join(' · ')} · up to {t.maxDays} days</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {def && (
        <Card className="h-fit space-y-4">
          <h2 className="text-lg font-bold text-fg">{def.title}</h2>
          <div className="grid grid-cols-2 gap-3">
            <DateInput label="From" value={f.dateFrom} onChange={(e) => set('dateFrom')(e.target.value)} />
            <DateInput label="To" value={f.dateTo} onChange={(e) => set('dateTo')(e.target.value)} />
          </div>
          {isManager(me) && has('siteIds') && <SitePicker placeholder="All locations" value={f.siteId} onChange={set('siteId')} />}
          {isManager(me) && has('departmentIds') && <Pick label="Department" placeholder="All departments" options={departments.map((d) => ({ value: d.id, label: d.name }))} value={f.departmentId} onChange={set('departmentId')} />}
          {isManager(me) && has('employeeIds') && <EmployeePicker label="Employee (optional)" value={f.employeeId} onChange={set('employeeId')} />}
          {has('groupBy') && <Pick label="Group" required options={GROUPS} value={f.groupBy} onChange={set('groupBy')} />}
          <div className="flex gap-2.5">
            {def.formats.includes('pdf') && <Button leftIcon={<FileText size={16} />} loading={run.isPending && run.variables === 'pdf'} onClick={() => run.mutate('pdf')}>PDF</Button>}
            {def.formats.includes('csv') && <Button variant="secondary" leftIcon={<FileSpreadsheet size={16} />} loading={run.isPending && run.variables === 'csv'} onClick={() => run.mutate('csv')}>CSV</Button>}
          </div>
        </Card>
      )}
    </div>
  );
}

function History() {
  const me = useMe();
  const [scope, setScope] = useState('mine');
  const [page, setPage] = useState(1);
  const size = 25;
  const { data: types } = useApi<ReportType[]>('/reports/types', undefined, { staleTime: Infinity });
  // Socket report.ready refreshes this; the poll is only the fallback while something is in flight.
  const { data, isLoading } = useApi<Page<Job>>('/reports/exports', { scope, page, size }, {
    refetchInterval: (q) => ((q.state.data as Page<Job> | undefined)?.items.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 5000 : false),
  });
  const title = (t: string) => types?.find((x) => x.type === t)?.title ?? t;
  return (
    <div className="space-y-4">
      {isHr(me) && <PillTabs label="Whose" value={scope} onChange={(v) => { setScope(v); setPage(1); }} tabs={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'Everyone' }]} />}
      <Panel>
        <DataTable rows={data?.items ?? []} getRowKey={(j) => j.id} loading={isLoading} empty={<EmptyState title="No exports yet" description="Exports you run or receive on a schedule appear here." />}
          columns={[
            { key: 't', header: 'Report', render: (j) => <span className="font-semibold text-fg">{title(j.type)} <span className="text-fg-subtle">{j.format.toUpperCase()}</span></span> },
            { key: 'c', header: 'Requested', render: (j) => dateTime(j.createdAt) + (j.scheduleId ? ' · scheduled' : '') },
            { key: 's', header: 'Status', render: (j) => <StatusBadge value={j.status} map={REQUEST_STATUS} /> },
            { key: 'r', header: 'Rows', align: 'right', render: (j) => j.rowCount ?? '' },
            { key: 'h', header: 'SHA-256', render: (j) => <span className="font-mono text-xs text-fg-subtle">{j.sha256?.slice(0, 12) ?? j.error ?? ''}</span> },
          ]}
          rowActions={(j) => j.status === 'READY' ? <IconButton label="Download" icon={<Download size={16} />} onClick={() => void downloadExport(j.id)} /> : null} />
      </Panel>
      {data && data.total > size && <Pagination page={page} pageCount={Math.ceil(data.total / size)} onPageChange={setPage} total={data.total} pageSize={size} noun="exports" />}
    </div>
  );
}

function Schedules() {
  const { data, isLoading } = useApi<Schedule[]>('/reports/schedules');
  const { data: types } = useApi<ReportType[]>('/reports/types', undefined, { staleTime: Infinity });
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const toggle = useAction((s: Schedule) => patch(`/reports/schedules/${s.id}`, { ...pickSchedule(s), enabled: !s.enabled }), { invalidate: ['/reports/schedules'] });
  const remove = useAction((id: string) => del(`/reports/schedules/${id}`), { invalidate: ['/reports/schedules'], success: 'Schedule removed' });
  return (
    <div className="space-y-4">
      <Button leftIcon={<Plus size={16} />} onClick={() => setEditing('new')}>New schedule</Button>
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(s) => s.id} loading={isLoading} onRowClick={setEditing}
          empty={<EmptyState title="No scheduled reports" description="Recipients get an in-app notification and push when each run is ready." />}
          columns={[
            { key: 'n', header: 'Name', render: (s) => <span className="font-semibold text-fg">{s.name}</span> },
            { key: 't', header: 'Report', render: (s) => `${types?.find((t) => t.type === s.type)?.title ?? s.type} · ${s.format.toUpperCase()}` },
            { key: 'c', header: 'When', render: (s) => <span className="font-mono text-xs">{s.cron} ({s.timezone})</span> },
            { key: 'l', header: 'Last run', render: (s) => dateTime(s.lastRunAt) },
            { key: 'e', header: 'Enabled', render: (s) => <span onClick={(e) => e.stopPropagation()}><Checkbox label={s.enabled ? 'On' : 'Off'} checked={s.enabled} onChange={() => toggle.mutate(s)} /></span> },
          ]}
          rowActions={(s) => <IconButton label="Remove schedule" icon={<Trash2 size={16} />} onClick={async (e) => { e.stopPropagation(); if (await confirmAction({ title: `Remove “${s.name}”?`, confirmLabel: 'Remove schedule' })) remove.mutate(s.id); }} />} />
      </Panel>
      {editing && <ScheduleForm schedule={editing === 'new' ? undefined : editing} types={types ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

const pickSchedule = (s: Schedule) => ({ name: s.name, type: s.type, format: s.format, filters: s.filters, cron: s.cron, timezone: s.timezone, recipientUserIds: s.recipientUserIds, enabled: s.enabled });

function ScheduleForm({ schedule, types, onClose }: { schedule?: Schedule; types: ReportType[]; onClose: () => void }) {
  const me = useMe();
  const users = useUsers(isHr(me)).data ?? [];
  const [f, set] = useForm({
    name: schedule?.name ?? '', type: schedule?.type ?? types[0]?.type ?? '', format: schedule?.format ?? 'pdf',
    period: (schedule?.filters.period as string) ?? 'yesterday', cron: schedule?.cron ?? '0 8 * * *',
    timezone: schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, recipientUserIds: schedule?.recipientUserIds ?? [me.id],
  });
  const def = types.find((t) => t.type === f.type);
  const body = { name: f.name, type: f.type, format: f.format, filters: { ...schedule?.filters, period: f.period }, cron: f.cron, timezone: f.timezone, recipientUserIds: f.recipientUserIds, enabled: schedule?.enabled ?? true };
  const save = useAction(() => (schedule ? patch(`/reports/schedules/${schedule.id}`, body) : post('/reports/schedules', body)), { invalidate: ['/reports/schedules'], success: 'Schedule saved', onSuccess: onClose });
  const toggleRecipient = (id: string, on: boolean) => set('recipientUserIds')(on ? [...f.recipientUserIds, id] : f.recipientUserIds.filter((x) => x !== id));
  return (
    <FormModal open onClose={onClose} size="drawer" title={schedule ? 'Edit schedule' : 'New schedule'} submitLabel="Save schedule" saving={save.isPending} onSubmit={() => save.mutate()}>
      <TextField label="Name" required value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder="Monday absenteeism brief" />
      <Pick label="Report" required options={types.map((t) => ({ value: t.type, label: t.title, keywords: t.description }))} value={f.type} onChange={set('type')} />
      <Pick label="Format" required options={(def?.formats ?? ['pdf', 'csv']).map((x) => ({ value: x, label: x.toUpperCase() }))} value={f.format} onChange={(v) => set('format')(v as 'csv' | 'pdf')} />
      <Pick label="Covers" required options={PERIODS} value={f.period} onChange={set('period')} />
      <TextField label="Cron" required value={f.cron} onChange={(e) => set('cron')(e.target.value)} hint="minute hour day month weekday — e.g. 0 8 * * 1 = Mondays 08:00" className="font-mono" />
      <TextField label="Timezone" required value={f.timezone} onChange={(e) => set('timezone')(e.target.value)} />
      {isHr(me) && (
        <div className="space-y-2">
          <p className="field-label">Recipients</p>
          {users.filter((u) => u.status === 'ACTIVE').map((u) => (
            <Checkbox key={u.userId} label={u.displayName} description={u.email} checked={f.recipientUserIds.includes(u.userId)} onChange={(e) => toggleRecipient(u.userId, e.target.checked)} />
          ))}
        </div>
      )}
    </FormModal>
  );
}
