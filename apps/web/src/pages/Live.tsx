import { ActivityFeed, Badge, BarChart, ChartCard, DataTable, DonutChart, EmptyState, PageHeader, PillTabs, StatCard, type Tone } from '@iverto-org/core-ui';
import { Clock, Home, LogIn, Plane, Timer, UserX, Moon, Cpu } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DayDrawer } from '../components/DayDrawer';
import { DepartmentSelect, Panel, SiteSelect } from '../components/ui';
import { useApi } from '../lib/api';
import { LIVE_STATE, StatusBadge } from '../lib/format';
import type { Board, Day } from '../lib/live';

/** Arrivals per 15 minutes vs shift starts, in each row's site time (local HH:mm from the API). */
function arrivals(rows: Day[]) {
  const slot = (hhmm: string | null) => (hhmm ? `${hhmm.slice(0, 2)}:${String(Math.floor(Number(hhmm.slice(3, 5)) / 15) * 15).padStart(2, '0')}` : null);
  const buckets = new Map<string, { slot: string; arrived: number; due: number }>();
  const add = (key: string | null, field: 'arrived' | 'due') => {
    if (!key) return;
    const b = buckets.get(key) ?? { slot: key, arrived: 0, due: 0 };
    b[field]++;
    buckets.set(key, b);
  };
  for (const r of rows) {
    add(slot(r.local.firstIn), 'arrived');
    add(slot(r.local.schedStart), 'due');
  }
  return [...buckets.values()].sort((a, b) => a.slot.localeCompare(b.slot));
}

export function Live() {
  const [siteId, setSite] = useState('');
  const [departmentId, setDept] = useState('');
  const [state, setState] = useState('ALL');
  const [dayId, setDayId] = useState<string | null>(null);
  // Always revalidate on mount; the cached snapshot paints first, sockets keep it current (§10).
  const { data, isLoading } = useApi<Board>('/live/board', { siteId, departmentId }, { staleTime: 0 });

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => state === 'ALL' || r.liveState === state), [data, state]);
  const s = data?.summary;
  const offline = (data?.devices ?? []).filter((d) => !d.online);

  const tiles: { title: string; value?: number; icon: typeof Clock; tone: 'brand' | 'info' | 'warning' | 'danger' | 'success' }[] = [
    { title: 'Present', value: s?.present, icon: LogIn, tone: 'success' },
    { title: 'Late', value: s?.late, icon: Timer, tone: 'warning' },
    { title: 'Absent', value: s?.absent, icon: UserX, tone: 'danger' },
    { title: 'Not yet in', value: s?.notYetIn, icon: Clock, tone: 'info' },
    { title: 'On leave', value: s?.onLeave, icon: Plane, tone: 'info' },
    { title: 'Remote', value: s?.remote, icon: Home, tone: 'brand' },
    { title: 'Off', value: s?.off, icon: Moon, tone: 'info' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Live board" subtitle={`${s?.scheduled ?? 0} scheduled today · updates as people scan`}
        filters={<div className="flex flex-col gap-2.5 sm:flex-row"><SiteSelect value={siteId} onChange={setSite} /><DepartmentSelect value={departmentId} onChange={setDept} /></div>} />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        {tiles.map((t) => <StatCard key={t.title} title={t.title} value={t.value ?? '–'} icon={<t.icon size={20} />} tone={t.tone} />)}
      </div>

      {offline.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger-fg">
          <Cpu size={16} /> {offline.length} terminal{offline.length > 1 ? 's' : ''} offline — scans there arrive when it reconnects, so some “absent” may be false:
          {offline.map((d) => <Badge key={d.id} tone="danger">{d.name ?? d.serialNo} · {d.gateName}</Badge>)}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Status mix" height={260}>
          <DonutChart centerValue={data?.rows.length ?? 0} centerLabel="people"
            data={Object.entries(data?.counts ?? {}).filter(([, v]) => v > 0).map(([k, v]) => ({ name: LIVE_STATE[k]?.label ?? k, value: v, tone: (LIVE_STATE[k]?.tone ?? 'neutral') as Tone }))} />
        </ChartCard>
        <ChartCard title="Arrivals" description="Per 15 minutes, against shift starts" height={260}>
          <BarChart data={arrivals(data?.rows ?? [])} xKey="slot" series={[{ key: 'due', label: 'Shift starts', tone: 'neutral' }, { key: 'arrived', label: 'Arrived', tone: 'brand' }]} />
        </ChartCard>
        <ChartCard title="Latest punches" height={260}>
          <div className="h-full overflow-y-auto">
            <ActivityFeed
              empty={<p className="text-sm text-fg-muted">No punches in the last 12 hours.</p>}
              items={(data?.recentPunches ?? []).map((p) => ({
                id: p.id,
                actor: p.employee?.fullName ?? `Unknown slot ${p.terminalUserId ?? ''}`,
                action: `punched ${p.direction === 'unknown' ? '' : p.direction} at ${p.device?.gateName ?? p.source.toLowerCase()}`,
                time: p.local.slice(11, 16),
                timestamp: `${p.local} (UTC${p.offset})`,
                tone: p.employeeId ? 'success' : 'warning',
              }))} />
          </div>
        </ChartCard>
      </div>

      <PillTabs label="Filter by state" value={state} onChange={setState}
        tabs={[{ value: 'ALL', label: 'Everyone', count: data?.rows.length }, ...Object.entries(LIVE_STATE).filter(([k]) => data?.counts[k]).map(([k, v]) => ({ value: k, label: v.label, count: data?.counts[k] }))]} />
      <Panel>
        <DataTable rows={rows} getRowKey={(r) => r.id} loading={isLoading} onRowClick={(r) => setDayId(r.id)}
          empty={<EmptyState title="Nobody scheduled here today" description="Try another site or department." />}
          columns={[
            { key: 'name', header: 'Employee', render: (r) => <span className="font-semibold text-fg">{r.employee?.fullName}</span> },
            { key: 'state', header: 'Now', render: (r) => <StatusBadge value={r.liveState} map={LIVE_STATE} /> },
            { key: 'shift', header: 'Shift', render: (r) => (r.local.schedStart ? `${r.local.schedStart}–${r.local.schedEnd}` : '—') },
            { key: 'in', header: 'In', render: (r) => r.local.firstIn ?? '—' },
            { key: 'out', header: 'Out', render: (r) => r.local.lastOut ?? '—' },
            { key: 'late', header: 'Late', align: 'right', render: (r) => (r.isLate ? `${r.lateMinutes} min` : '') },
          ]} />
      </Panel>
      <DayDrawer dayId={dayId} onClose={() => setDayId(null)} />
    </div>
  );
}
