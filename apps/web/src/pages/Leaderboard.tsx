import { Badge, CellStack, DataTable, EmptyState, PageHeader, SegmentedControl, TextField } from '@iverto-org/core-ui';
import { Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DepartmentSelect, Panel, SiteSelect } from '../components/ui';
import { useApi, useDepartments } from '../lib/api';
import { today } from '../lib/format';
import { byRank, score, type MonthTotals, type Score } from '../lib/leaderboard';

type Ranked = Score & { key: string; name: string; sub?: string; rank: number };

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);
const days = (v: number) => (v ? String(v) : '');

function AttendancePct({ v }: { v: number | null }) {
  if (v === null) return <span className="text-fg-muted">—</span>;
  return <Badge tone={v >= 90 ? 'success' : v >= 75 ? 'warning' : 'danger'}>{pct(v)}</Badge>;
}

function Rank({ n }: { n: number }) {
  return n <= 3
    ? <span className="inline-flex items-center gap-1 font-bold text-fg"><Trophy size={14} className={['text-warning', 'text-fg-muted', 'text-orange-700'][n - 1]} />{n}</span>
    : <span className="text-fg-muted">{n}</span>;
}

export function Leaderboard() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [siteId, setSite] = useState('');
  const [departmentId, setDept] = useState('');
  const [view, setView] = useState('employees');
  const { data, isLoading } = useApi<{ totals: MonthTotals[] }>('/attendance/overview', { month, siteId, departmentId });
  const departments = useDepartments().data ?? [];
  const leaveCounts = Boolean(useApi<{ settings: Record<string, unknown> }>('/org').data?.settings.leaveCountsAgainstAttendance);

  const rows = useMemo<Ranked[]>(() => {
    const totals = data?.totals ?? [];
    const ranked = view === 'employees'
      ? totals.map((t) => ({
          ...score([t], leaveCounts), key: t.employee.id, name: t.employee.fullName,
          sub: [t.employee.employeeCode, departments.find((d) => d.id === t.employee.departmentId)?.name].filter(Boolean).join(' · '),
        }))
      : [...totals.reduce((m, t) => m.set(t.employee.departmentId ?? '', [...(m.get(t.employee.departmentId ?? '') ?? []), t]), new Map<string, MonthTotals[]>())].map(([id, list]) => ({
          ...score(list, leaveCounts), key: id || 'none', name: departments.find((d) => d.id === id)?.name ?? 'No department',
        }));
    return ranked.sort(byRank).map((r, i) => ({ ...r, rank: i + 1 }));
  }, [data, view, departments, leaveCounts]);

  return (
    <div className="space-y-6">
      <PageHeader title="Leaderboard" subtitle={`Attendance after the late penalty, and how often people arrive late. Approved leave ${leaveCounts ? 'counts as not present' : 'is left out'}; unapproved absences count.`}
        filters={
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-4">
            <TextField label="Month" hideLabel type="month" value={month} onChange={(e) => setMonth(e.target.value)} containerClassName="sm:w-44" />
            <SiteSelect value={siteId} onChange={setSite} />
            {view === 'employees' && <DepartmentSelect value={departmentId} onChange={setDept} />}
            <SegmentedControl label="Rank" value={view} onChange={(v) => { setView(v); setDept(''); }}
              options={[{ value: 'employees', label: 'Employees' }, { value: 'departments', label: 'Departments' }]} />
          </div>
        } />
      <Panel>
        <DataTable rows={rows} getRowKey={(r) => r.key} loading={isLoading}
          empty={<EmptyState icon={Trophy} title="No attendance this month" description="Try another month or filter." />}
          columns={[
            { key: 'rank', header: '#', render: (r) => <Rank n={r.rank} /> },
            { key: 'name', header: view === 'employees' ? 'Employee' : 'Department', render: (r) => <CellStack primary={r.name} secondary={r.sub ?? `${r.people} ${r.people === 1 ? 'person' : 'people'}`} /> },
            { key: 'att', header: 'Attendance', align: 'right', render: (r) => <AttendancePct v={r.attendancePct} /> },
            { key: 'late', header: 'Late', align: 'right', render: (r) => pct(r.latePct) },
            { key: 'present', header: 'Present', align: 'right', render: (r) => `${r.present} / ${r.working}` },
            { key: 'leave', header: 'Leave', align: 'right', render: (r) => days(r.leave) },
            { key: 'absent', header: 'Absent', align: 'right', render: (r) => days(r.absent) },
            { key: 'lateDays', header: 'Late days', align: 'right', render: (r) => days(r.lateDays) },
            { key: 'ded', header: 'Late penalty', align: 'right', render: (r) => (r.deduction ? `−${r.deduction} d` : '') },
          ]} />
      </Panel>
    </div>
  );
}
