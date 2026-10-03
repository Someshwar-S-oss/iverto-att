import { Badge, Button, confirmAction, DataTable, DateInput, EmptyState, IconButton, PageHeader, TextField, Tooltip } from '@iverto-org/core-ui';
import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Crud } from '../components/Crud';
import { DepartmentSelect, FormModal, Panel, Pick, SiteSelect, useForm } from '../components/ui';
import { del, patch, post, put, REFERENCE, useAction, useApi, usePolicies, useShifts, type Shift } from '../lib/api';
import { addDays, hm, StatusBadge, today, WEEKDAYS } from '../lib/format';

export function Shifts() {
  const policies = usePolicies().data ?? [];
  return (
    <Crud<Shift> title="Shifts" subtitle="Wall-clock times in each site’s timezone. A shift that ends before it starts runs overnight." path="/shifts" noun="shift"
      blank={{ name: '', code: '', color: '#cd0447', kind: 'FIXED', startTime: '09:00', endTime: '18:00', breakMinutes: 60, requiredMinutes: '', coreStart: '', coreEnd: '', worksHolidays: false, policyId: '', isDefault: false, active: true }}
      toForm={(s) => ({ ...s, coreStart: (s as any).coreStart ?? '', coreEnd: (s as any).coreEnd ?? '', policyId: (s as any).policyId ?? '' })}
      columns={[
        { key: 'name', header: 'Shift', render: (s) => <span className="flex items-center gap-2 font-semibold text-fg"><span className="size-3 rounded-full" style={{ background: s.color ?? '#9ca3af' }} />{s.name} <span className="font-mono text-xs text-fg-subtle">{s.code}</span></span> },
        { key: 'time', header: 'Time', render: (s) => `${s.startTime}–${s.endTime}${s.isNight ? ' (overnight)' : ''}` },
        { key: 'req', header: 'Required', render: (s) => hm(s.requiredMinutes) },
        { key: 'flags', header: '', render: (s) => <span className="flex gap-1.5">{s.isDefault && <Badge tone="brand">Default</Badge>}{!s.active && <Badge tone="neutral">Inactive</Badge>}{s.kind === 'FLEXIBLE' && <Badge tone="info">Flexible</Badge>}</span> },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'code', label: 'Short code', required: true, hint: 'Shown in the roster grid' },
        { key: 'color', label: 'Colour', type: 'color' },
        { key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'FIXED', label: 'Fixed hours' }, { value: 'FLEXIBLE', label: 'Flexible (core hours)' }] },
        { key: 'startTime', label: 'Starts', type: 'time', required: true },
        { key: 'endTime', label: 'Ends', type: 'time', required: true },
        { key: 'breakMinutes', label: 'Break (minutes)', type: 'number', required: true },
        { key: 'requiredMinutes', label: 'Required minutes', type: 'number', when: (f) => f.kind === 'FLEXIBLE' },
        { key: 'coreStart', label: 'Core hours start', type: 'time', when: (f) => f.kind === 'FLEXIBLE' },
        { key: 'coreEnd', label: 'Core hours end', type: 'time', when: (f) => f.kind === 'FLEXIBLE' },
        { key: 'policyId', label: 'Attendance policy', type: 'select', placeholder: 'Tenant default', options: policies.map((p) => ({ value: p.id, label: p.name })) },
        { key: 'worksHolidays', label: 'Works on holidays', type: 'bool' },
        { key: 'isDefault', label: 'Default for new employees', type: 'bool' },
        { key: 'active', label: 'Active', type: 'bool' },
      ]} />
  );
}

interface Pattern { id: string; name: string; cycleDays: number; days: (string | null)[] }

export function Patterns() {
  const shifts = useShifts().data ?? [];
  const { data, isLoading } = useApi<Pattern[]>('/shift-patterns', undefined, REFERENCE);
  const [editing, setEditing] = useState<Pattern | 'new' | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState<(string | null)[]>([]);
  const byId = new Map(shifts.map((s) => [s.id, s]));
  const open = (p: Pattern | 'new') => {
    setName(p === 'new' ? '' : p.name);
    setDays(p === 'new' ? [null, null, null, null, null, null, null] : p.days);
    setEditing(p);
  };
  const save = useAction(() => (editing === 'new' ? post('/shift-patterns', { name, days }) : patch(`/shift-patterns/${(editing as Pattern).id}`, { name, days })), {
    invalidate: ['/shift-patterns', '/roster'], success: 'Pattern saved', onSuccess: () => setEditing(null),
  });
  const remove = useAction((id: string) => del(`/shift-patterns/${id}`), { invalidate: ['/shift-patterns'], success: 'Pattern removed' });
  const chip = (id: string | null, i: number) => {
    const s = id ? byId.get(id) : null;
    return <span key={i} className="rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold" style={s ? { background: `${s.color ?? '#9ca3af'}22`, color: s.color ?? undefined } : undefined}>{s?.code ?? 'off'}</span>;
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Rotation patterns" subtitle="A repeating cycle of shifts and off days, e.g. M M N N off off." actions={<Button leftIcon={<Plus size={16} />} onClick={() => open('new')}>Add pattern</Button>} />
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(p) => p.id} loading={isLoading} onRowClick={open} empty={<EmptyState title="No patterns yet" description="Patterns are for rotating shifts. Fixed shifts don’t need one." />}
          columns={[
            { key: 'name', header: 'Pattern', render: (p) => <span className="font-semibold text-fg">{p.name}</span> },
            { key: 'cycle', header: 'Cycle', render: (p) => `${p.cycleDays} days` },
            { key: 'days', header: 'Days', render: (p) => <span className="flex flex-wrap gap-1">{p.days.map(chip)}</span> },
          ]}
          rowActions={(p) => <IconButton label="Remove pattern" icon={<Trash2 size={16} />} onClick={async (e) => { e.stopPropagation(); if (await confirmAction({ title: 'Remove this pattern?', message: 'Patterns assigned to employees cannot be removed.', confirmLabel: 'Remove pattern' })) remove.mutate(p.id); }} />} />
      </Panel>
      <FormModal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add pattern' : 'Edit pattern'} submitLabel="Save pattern" saving={save.isPending} onSubmit={() => save.mutate()}>
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        <div className="space-y-2">
          {days.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-14 text-sm text-fg-muted">Day {i + 1}</span>
              <div className="flex-1"><Pick label={<span className="sr-only">Day {i + 1}</span>} placeholder="Off — search shifts" value={d ?? ''} onChange={(v) => setDays(days.map((x, j) => (j === i ? v || null : x)))}
                options={shifts.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name, description: `${s.code} · ${s.startTime}–${s.endTime}` }))} /></div>
              <IconButton label="Remove day" icon={<X size={16} />} disabled={days.length === 1} onClick={() => setDays(days.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button variant="ghost" size="sm" leftIcon={<Plus size={14} />} onClick={() => setDays([...days, null])}>Add day</Button>
        </div>
      </FormModal>
    </div>
  );
}

interface RosterCell { date: string; dayType: string; shiftId: string | null; holidayName: string | null; status: string | null; override: { shiftId: string | null; reason: string | null } | null; conflicts: string[] }
interface Roster { rows: { employee: { id: string; fullName: string; employeeCode: string }; cells: RosterCell[] }[] }

const CONFLICT: Record<string, string> = { REST_TOO_SHORT: 'Rest before this shift is under the policy minimum', LEAVE_OVERLAP: 'Scheduled to work during leave', WEEKLY_HOURS_EXCEEDED: 'Over the weekly hours limit' };

export function Roster() {
  const [from, setFrom] = useState(today());
  const [siteId, setSite] = useState('');
  const [departmentId, setDept] = useState('');
  const [cell, setCell] = useState<{ employeeId: string; name: string; c: RosterCell } | null>(null);
  const to = addDays(from, 13);
  const shifts = useShifts().data ?? [];
  const byId = new Map(shifts.map((s) => [s.id, s]));
  const { data, isLoading } = useApi<Roster>('/roster', { from, to, siteId, departmentId });
  const dates = Array.from({ length: 14 }, (_, i) => addDays(from, i));

  return (
    <div className="space-y-6">
      <PageHeader title="Roster planner" subtitle="Two weeks at a time. Click a day to change that person’s shift; warnings never block you."
        filters={
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
            <DateInput label="Starting" value={from} onChange={(e) => setFrom(e.target.value)} className="sm:w-44" />
            <SiteSelect value={siteId} onChange={setSite} />
            <DepartmentSelect value={departmentId} onChange={setDept} />
          </div>
        } />
      <Panel>
        {/* ponytail: click-to-override; add drag-to-paint and bulk select when planners ask for it. */}
        <div className="grid text-xs" style={{ gridTemplateColumns: 'minmax(10rem, 14rem) repeat(14, minmax(3rem, 1fr))' }}>
          <div className="sticky left-0 bg-surface-raised px-3 py-2 font-semibold uppercase text-fg-subtle">Employee</div>
          {dates.map((d) => (
            <div key={d} className="py-2 text-center font-semibold text-fg-subtle">{WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}<br />{Number(d.slice(8))}</div>
          ))}
          {(data?.rows ?? []).map((r) => (
            <div key={r.employee.id} className="contents">
              <div className="sticky left-0 truncate border-t border-line-soft bg-surface-raised px-3 py-2 font-medium text-fg">{r.employee.fullName}</div>
              {r.cells.map((c) => {
                const s = c.shiftId ? byId.get(c.shiftId) : null;
                const label = c.dayType === 'HOLIDAY' ? 'H' : c.dayType === 'WORKING' ? s?.code ?? '?' : 'off';
                const body = (
                  <button onClick={() => setCell({ employeeId: r.employee.id, name: r.employee.fullName, c })}
                    className={`relative m-0.5 w-[calc(100%-4px)] rounded-md border-t border-line-soft py-2 text-center font-mono font-semibold ${c.dayType !== 'WORKING' ? 'text-fg-subtle' : ''} ${c.conflicts.length ? 'ring-2 ring-warning' : ''}`}
                    style={s && c.dayType === 'WORKING' ? { background: `${s.color ?? '#9ca3af'}22`, color: s.color ?? undefined } : undefined}>
                    {label}
                    {c.override && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-brand" aria-label="Override" />}
                  </button>
                );
                const tip = [c.holidayName, c.override && `Override${c.override.reason ? `: ${c.override.reason}` : ''}`, ...c.conflicts.map((k) => CONFLICT[k] ?? k)].filter(Boolean).join(' · ');
                return tip ? <Tooltip key={c.date} content={tip}>{body}</Tooltip> : <div key={c.date}>{body}</div>;
              })}
            </div>
          ))}
        </div>
        {!isLoading && !data?.rows.length && <EmptyState title="No one to plan here" description="Try another site or department." />}
        <p className="border-t border-line-soft px-4 py-3 text-xs text-fg-muted">Dot = override · amber ring = warning (hover for detail) · H = holiday</p>
      </Panel>
      {cell && <OverrideModal {...cell} shifts={shifts} onClose={() => setCell(null)} />}
    </div>
  );
}

function OverrideModal({ employeeId, name, c, shifts, onClose }: { employeeId: string; name: string; c: RosterCell; shifts: Shift[]; onClose: () => void }) {
  const [f, set] = useForm({ shiftId: c.override ? c.override.shiftId ?? 'OFF' : c.shiftId ?? 'OFF', reason: c.override?.reason ?? '' });
  const past = c.date < today();
  const save = useAction(() => put('/roster/overrides', { items: [{ employeeId, date: c.date, shiftId: f.shiftId === 'OFF' ? null : f.shiftId, reason: f.reason || undefined }], reevaluateHistory: past }), {
    invalidate: ['/roster', '/attendance'], success: 'Roster updated', onSuccess: onClose,
  });
  const revert = useAction(() => del('/roster/overrides', { items: [{ employeeId, date: c.date }], reevaluateHistory: past }), { invalidate: ['/roster', '/attendance'], success: 'Back to the normal schedule', onSuccess: onClose });
  return (
    <FormModal open onClose={onClose} title={`${name} · ${c.date}`} description={past ? 'A past day: saving re-evaluates it (audited).' : undefined} submitLabel="Save" saving={save.isPending} onSubmit={() => save.mutate()}>
      <Pick label="Shift" required options={[{ value: 'OFF', label: 'Day off' }, ...shifts.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name, description: `${s.code} · ${s.startTime}–${s.endTime}` }))]} value={f.shiftId} onChange={set('shiftId')} />
      <TextField label="Reason" maxLength={300} value={f.reason} onChange={(e) => set('reason')(e.target.value)} />
      {c.status && <p className="text-sm text-fg-muted">Current status: <StatusBadge value={c.status} /></p>}
      {c.override && <Button variant="ghost" loading={revert.isPending} onClick={() => revert.mutate()}>Revert to normal schedule</Button>}
    </FormModal>
  );
}

