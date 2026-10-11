import {
  Badge, Button, Callout, Card, confirmAction, DataTable, DateInput, EmptyState, IconButton, Modal, Select, Switch, TextField, Textarea,
} from '@iverto-org/core-ui';
import { ArrowDown, ArrowUp, Eye, FilePlus2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '../components/ui';
import { del, patch, post, useAction, useApi } from '../lib/api';
import { today } from '../lib/format';

// Mirrors apps/api/src/reports/custom.ts.
type FieldType = 'text' | 'number' | 'minutes' | 'date' | 'bool' | 'enum';
interface FieldDef { key: string; label: string; type: FieldType; options?: { value: string; label: string }[] }
interface SourceDef { key: string; label: string; description: string; row: string; maxDays: number; fields: FieldDef[] }
interface Cond { field: string; op: string; value?: unknown }
interface Col { field?: string; agg?: string; where?: Cond[]; label?: string }
interface Spec { source: string; columns: Col[]; where: Cond[]; sectionBy?: string | null; sort?: { column: number; dir: 'asc' | 'desc' } | null; chart?: boolean; landscape?: boolean }
interface Template { id: string; name: string; description: string | null; spec: Spec }
interface Preview {
  from: string; to: string; total: number;
  kpis: { label: string; value: string | number }[];
  sections: { title?: string; columns: { key: string; label: string; align?: 'right' | 'center' }[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown> }[];
}

const OPS: Record<FieldType, { value: string; label: string }[]> = {
  text: [{ value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'contains', label: 'contains' }, { value: 'empty', label: 'is empty' }, { value: 'notEmpty', label: 'is not empty' }],
  enum: [{ value: 'in', label: 'is any of' }, { value: 'nin', label: 'is none of' }],
  bool: [{ value: 'isTrue', label: 'is yes' }, { value: 'isFalse', label: 'is no' }],
  number: [{ value: 'eq', label: '=' }, { value: 'neq', label: '≠' }, { value: 'gt', label: '>' }, { value: 'gte', label: '≥' }, { value: 'lt', label: '<' }, { value: 'lte', label: '≤' }],
  minutes: [{ value: 'gt', label: 'more than (min)' }, { value: 'gte', label: 'at least (min)' }, { value: 'lt', label: 'less than (min)' }, { value: 'lte', label: 'at most (min)' }, { value: 'eq', label: 'exactly (min)' }],
  date: [{ value: 'eq', label: 'on' }, { value: 'lt', label: 'before' }, { value: 'gt', label: 'after' }, { value: 'lte', label: 'on or before' }, { value: 'gte', label: 'on or after' }],
};
const NO_VALUE = ['isTrue', 'isFalse', 'empty', 'notEmpty'];
const AGGS = [
  { value: 'count', label: 'Count of rows' }, { value: 'percent', label: '% of rows' }, { value: 'sum', label: 'Total of' }, { value: 'avg', label: 'Average of' },
  { value: 'min', label: 'Lowest / earliest' }, { value: 'max', label: 'Highest / latest' }, { value: 'distinct', label: 'Number of different' },
];

/** Starting points so nobody faces a blank page. */
const STARTERS: { name: string; spec: Spec }[] = [
  { name: 'Blank list', spec: { source: 'days', columns: [{ field: 'date' }, { field: 'employeeName' }, { field: 'status' }], where: [] } },
  {
    name: 'Attendance by employee',
    spec: {
      source: 'days', where: [{ field: 'dayType', op: 'in', value: ['WORKING'] }], chart: true, sort: { column: 4, dir: 'desc' },
      columns: [
        { field: 'employeeName' }, { field: 'department' },
        { agg: 'count', where: [{ field: 'status', op: 'in', value: ['PRESENT', 'REMOTE'] }], label: 'Present' },
        { agg: 'count', where: [{ field: 'status', op: 'in', value: ['ABSENT'] }], label: 'Absent' },
        { agg: 'percent', where: [{ field: 'status', op: 'in', value: ['PRESENT', 'REMOTE'] }], label: 'Attendance %' },
        { agg: 'count', where: [{ field: 'isLate', op: 'isTrue' }], label: 'Late days' },
      ],
    },
  },
  {
    name: 'Late arrivals by department',
    spec: {
      source: 'days', where: [{ field: 'isLate', op: 'isTrue' }], chart: true, sort: { column: 1, dir: 'desc' },
      columns: [{ field: 'department' }, { agg: 'count', label: 'Late arrivals' }, { agg: 'distinct', field: 'employeeName', label: 'People' }, { agg: 'avg', field: 'lateMinutes', label: 'Average late by' }],
    },
  },
  { name: 'Headcount by department', spec: { source: 'employees', where: [{ field: 'status', op: 'in', value: ['ACTIVE'] }], chart: true, columns: [{ field: 'department' }, { agg: 'count', label: 'Headcount' }] } },
];

export function CustomReports() {
  const { data, isLoading } = useApi<Template[]>('/reports/templates');
  const [editing, setEditing] = useState<{ id?: string; name: string; description: string; spec: Spec } | null>(null);
  const remove = useAction((id: string) => del(`/reports/templates/${id}`), { invalidate: ['/reports/templates', '/reports/types'], success: 'Report deleted' });
  return (
    <div className="space-y-4">
      <Callout tone="info" title="Build your own reports">
        Pick a data source, the columns you want and any calculations. Saved reports appear under Export and Schedules for everyone who can export, limited to the people they can see.
      </Callout>
      <div className="flex flex-wrap gap-2">
        {STARTERS.map((s, i) => (
          <Button key={s.name} variant={i ? 'secondary' : 'primary'} leftIcon={i ? <FilePlus2 size={16} /> : <Plus size={16} />}
            onClick={() => setEditing({ name: i ? s.name : '', description: '', spec: structuredClone(s.spec) })}>
            {i ? s.name : 'New report'}
          </Button>
        ))}
      </div>
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(t) => t.id} loading={isLoading} onRowClick={(t) => setEditing({ id: t.id, name: t.name, description: t.description ?? '', spec: { ...t.spec, where: t.spec.where ?? [] } })}
          empty={<EmptyState icon={FilePlus2} title="No custom reports yet" description="Start from one of the templates above." />}
          columns={[
            { key: 'n', header: 'Report', render: (t) => <div><div className="font-semibold text-fg">{t.name}</div>{t.description && <div className="text-xs text-fg-muted">{t.description}</div>}</div> },
            { key: 's', header: 'Data', render: (t) => <Badge tone="neutral">{t.spec.source}</Badge> },
            { key: 'c', header: 'Columns', align: 'right', render: (t) => t.spec.columns.length },
          ]}
          rowActions={(t) => <>
            <IconButton label="Edit" icon={<Pencil size={16} />} onClick={() => setEditing({ id: t.id, name: t.name, description: t.description ?? '', spec: { ...t.spec, where: t.spec.where ?? [] } })} />
            <IconButton label="Delete" icon={<Trash2 size={16} />} onClick={async (e) => { e.stopPropagation(); if (await confirmAction({ title: `Delete “${t.name}”?`, message: 'Past exports stay downloadable.', confirmLabel: 'Delete report' })) remove.mutate(t.id); }} />
          </>} />
      </Panel>
      {editing && <Builder initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Builder({ initial, onClose }: { initial: { id?: string; name: string; description: string; spec: Spec }; onClose: () => void }) {
  const sources = useApi<SourceDef[]>('/reports/fields', undefined, { staleTime: Infinity }).data ?? [];
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [spec, setSpec] = useState<Spec>(initial.spec);
  const [range, setRange] = useState({ dateFrom: today().slice(0, 8) + '01', dateTo: today() });
  const [preview, setPreview] = useState<Preview | null>(null);
  const src = sources.find((s) => s.key === spec.source);
  const fieldOpts = (src?.fields ?? []).map((f) => ({ value: f.key, label: f.label }));
  const up = (patchSpec: Partial<Spec>) => { setSpec((s) => ({ ...s, ...patchSpec })); setPreview(null); };
  const setCol = (i: number, c: Col | null) => up({ columns: c ? spec.columns.map((x, j) => (j === i ? c : x)) : spec.columns.filter((_, j) => j !== i), ...(c ? {} : { sort: null }) });
  const move = (i: number, d: number) => { const cols = [...spec.columns]; [cols[i], cols[i + d]] = [cols[i + d], cols[i]]; up({ columns: cols, sort: null }); };

  const run = useAction(() => post<Preview>('/reports/templates/preview', { spec, filters: range }), { onSuccess: setPreview });
  const save = useAction(() => {
    const body = { name, description: description || undefined, spec };
    return initial.id ? patch(`/reports/templates/${initial.id}`, body) : post('/reports/templates', body);
  }, { invalidate: ['/reports/templates', '/reports/types'], success: 'Report saved — find it under Export', onSuccess: onClose });

  return (
    <Modal open onClose={onClose} size="drawer" title={initial.id ? 'Edit report' : 'New report'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={save.isPending} disabled={name.trim().length < 2 || !spec.columns.length} onClick={() => save.mutate()}>Save report</Button>
      </>}>
      <div className="space-y-6 p-5 sm:p-6">
        <section className="space-y-3">
          <TextField label="Report name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Monthly punctuality by team" />
          <Textarea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          <Select label="Data source" value={spec.source} options={sources.map((s) => ({ value: s.key, label: s.label }))}
            onChange={(e) => up({ source: e.target.value, columns: [], where: [], sectionBy: null, sort: null })}
            hint={src && `${src.description} One row = ${src.row}. Up to ${src.maxDays} days per run.`} />
        </section>

        <section className="space-y-2">
          <h3 className="font-bold text-fg">Columns</h3>
          <p className="text-xs text-fg-muted">Add a calculation and the report becomes a summary: one row per combination of the plain columns.</p>
          {spec.columns.map((c, i) => (
            <Card key={i} padding="sm" className="space-y-2">
              <div className="flex flex-wrap items-end gap-2">
                <Select label="Show" containerClassName="w-full sm:w-52" value={c.agg ? `agg:${c.agg}` : 'field'}
                  options={[{ value: 'field', label: 'A field' }, ...AGGS.map((a) => ({ value: `agg:${a.value}`, label: a.label }))]}
                  onChange={(e) => {
                    const agg = e.target.value.startsWith('agg:') ? e.target.value.slice(4) : undefined;
                    setCol(i, { label: c.label, agg, field: agg === 'count' || agg === 'percent' ? undefined : c.field ?? fieldOpts[0]?.value, where: agg ? c.where ?? (agg === 'percent' ? [blankCond(src)] : []) : undefined });
                  }} />
                {c.agg !== 'count' && c.agg !== 'percent' && (
                  <Select label="Field" containerClassName="w-full sm:w-52" value={c.field ?? ''} options={fieldOpts} placeholder="Pick a field" onChange={(e) => setCol(i, { ...c, field: e.target.value })} />
                )}
                <TextField label="Heading" containerClassName="w-full sm:w-44" placeholder="Automatic" value={c.label ?? ''} onChange={(e) => setCol(i, { ...c, label: e.target.value || undefined })} />
                <div className="ml-auto flex">
                  <IconButton label="Move up" icon={<ArrowUp size={16} />} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton label="Move down" icon={<ArrowDown size={16} />} disabled={i === spec.columns.length - 1} onClick={() => move(i, 1)} />
                  <IconButton label="Remove column" icon={<X size={16} />} onClick={() => setCol(i, null)} />
                </div>
              </div>
              {c.agg && src && (
                <Conditions src={src} label={c.agg === 'percent' ? 'Percentage of rows where' : 'Only count rows where'} value={c.where ?? []} onChange={(where) => setCol(i, { ...c, where })} />
              )}
            </Card>
          ))}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" leftIcon={<Plus size={14} />} disabled={!src} onClick={() => up({ columns: [...spec.columns, { field: fieldOpts[0]?.value }] })}>Field</Button>
            <Button size="sm" variant="secondary" leftIcon={<Plus size={14} />} disabled={!src} onClick={() => up({ columns: [...spec.columns, { agg: 'count', where: [] }] })}>Calculation</Button>
          </div>
        </section>

        {src && (
          <section className="space-y-2">
            <h3 className="font-bold text-fg">Filter</h3>
            <Conditions src={src} label="Only include rows where" value={spec.where} onChange={(where) => up({ where })} />
          </section>
        )}

        <section className="grid gap-3 sm:grid-cols-2">
          <Select label="Split into sections by" placeholder="No sections" value={spec.sectionBy ?? ''} options={fieldOpts} onChange={(e) => up({ sectionBy: e.target.value || null })} />
          <div className="flex items-end gap-2">
            <Select label="Sort by" placeholder="Default order" containerClassName="flex-1" value={spec.sort ? String(spec.sort.column) : ''}
              options={spec.columns.map((c, i) => ({ value: String(i), label: c.label || (c.agg ? AGGS.find((a) => a.value === c.agg)!.label : src?.fields.find((f) => f.key === c.field)?.label ?? `Column ${i + 1}`) }))}
              onChange={(e) => up({ sort: e.target.value === '' ? null : { column: Number(e.target.value), dir: spec.sort?.dir ?? 'desc' } })} />
            {spec.sort && <Select hideLabel label="Direction" containerClassName="w-36" value={spec.sort.dir} options={[{ value: 'desc', label: 'High → low' }, { value: 'asc', label: 'Low → high' }]} onChange={(e) => up({ sort: { ...spec.sort!, dir: e.target.value as 'asc' | 'desc' } })} />}
          </div>
          <Switch label="Bar chart" description="First calculation, top 15" checked={Boolean(spec.chart)} onChange={(chart) => up({ chart })} />
          <Switch label="Landscape PDF" description="For wide reports" checked={Boolean(spec.landscape)} onChange={(landscape) => up({ landscape })} />
        </section>

        <section className="space-y-3 border-t border-line-soft pt-5">
          <div className="flex flex-wrap items-end gap-2">
            <DateInput label="Preview from" value={range.dateFrom} onChange={(e) => setRange((r) => ({ ...r, dateFrom: e.target.value }))} />
            <DateInput label="to" value={range.dateTo} onChange={(e) => setRange((r) => ({ ...r, dateTo: e.target.value }))} />
            <Button variant="secondary" leftIcon={<Eye size={16} />} loading={run.isPending} disabled={!spec.columns.length} onClick={() => run.mutate()}>Preview</Button>
          </div>
          {preview && <PreviewTable p={preview} />}
        </section>
      </div>
    </Modal>
  );
}

const blankCond = (src?: SourceDef): Cond => {
  const f = src?.fields.find((x) => x.type === 'enum') ?? src?.fields[0];
  return { field: f?.key ?? '', op: OPS[f?.type ?? 'text'][0].value, value: f?.type === 'enum' ? [] : '' };
};

function Conditions({ src, label, value, onChange }: { src: SourceDef; label: string; value: Cond[]; onChange: (v: Cond[]) => void }) {
  const set = (i: number, c: Cond | null) => onChange(c ? value.map((x, j) => (j === i ? c : x)) : value.filter((_, j) => j !== i));
  return (
    <div className="space-y-2">
      {value.length > 0 && <p className="text-xs font-semibold text-fg-muted">{label}{value.length > 1 ? ' (all of these)' : ''}</p>}
      {value.map((c, i) => {
        const f = src.fields.find((x) => x.key === c.field) ?? src.fields[0];
        const list = Array.isArray(c.value) ? (c.value as string[]) : [];
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select hideLabel label="Field" containerClassName="w-full sm:w-48" value={f.key} options={src.fields.map((x) => ({ value: x.key, label: x.label }))}
              onChange={(e) => { const nf = src.fields.find((x) => x.key === e.target.value)!; set(i, { field: nf.key, op: OPS[nf.type][0].value, value: nf.type === 'enum' ? [] : '' }); }} />
            <Select hideLabel label="Operator" containerClassName="w-full sm:w-40" value={c.op} options={OPS[f.type]} onChange={(e) => set(i, { ...c, op: e.target.value })} />
            {f.type === 'enum' ? (
              <div className="flex flex-wrap gap-1.5">
                {f.options!.map((o) => (
                  <button key={o.value} type="button" onClick={() => set(i, { ...c, value: list.includes(o.value) ? list.filter((v) => v !== o.value) : [...list, o.value] })}
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${list.includes(o.value) ? 'border-brand bg-brand-soft font-semibold text-brand' : 'border-line text-fg-muted'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            ) : NO_VALUE.includes(c.op) ? null : f.type === 'date' ? (
              <DateInput aria-label="Value" value={String(c.value ?? '')} onChange={(e) => set(i, { ...c, value: e.target.value })} />
            ) : (
              <TextField hideLabel label="Value" containerClassName="w-full sm:w-40" type={f.type === 'number' || f.type === 'minutes' ? 'number' : 'text'} value={String(c.value ?? '')}
                onChange={(e) => set(i, { ...c, value: f.type === 'number' || f.type === 'minutes' ? Number(e.target.value) : e.target.value })} />
            )}
            <IconButton label="Remove condition" icon={<X size={16} />} onClick={() => set(i, null)} />
          </div>
        );
      })}
      <Button size="sm" variant="ghost" leftIcon={<Plus size={14} />} onClick={() => onChange([...value, blankCond(src)])}>Condition</Button>
    </div>
  );
}

function PreviewTable({ p }: { p: Preview }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {p.kpis.map((k) => <Badge key={k.label} tone="neutral">{k.label}: <b className="ml-1">{k.value}</b></Badge>)}
      </div>
      {p.sections.map((s, i) => (
        <div key={i} className="space-y-1">
          {s.title && <h4 className="text-sm font-bold text-fg">{s.title}</h4>}
          <Panel>
            <DataTable stackOnMobile={false} rows={[...s.rows, ...(s.totals ? [s.totals] : [])]} getRowKey={(r) => String(s.rows.indexOf(r))}
              empty={<EmptyState title="No rows match" description="Widen the dates or loosen the filter." />}
              columns={s.columns.map((c) => ({ key: c.key, header: c.label, align: c.align, render: (r: Record<string, unknown>) => <span className={r === s.totals ? 'font-bold' : ''}>{String(r[c.key] ?? '')}</span> }))} />
          </Panel>
        </div>
      ))}
      <p className="text-xs text-fg-muted">{p.from} – {p.to} · showing up to 50 rows per section of {p.total}. Exports include everything.</p>
    </div>
  );
}
