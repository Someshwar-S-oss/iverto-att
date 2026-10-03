import { Badge, Button, Callout, Card, Checkbox, confirmAction, DataTable, DateInput, EmptyState, FileDropzone, IconButton, Modal, PageHeader, SearchInput, Select, TextField } from '@iverto-org/core-ui';
import { Download, MapPin, Plus, Trash2, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FormModal, Panel, useForm } from '../components/ui';
import { del, post, put, REFERENCE, useAction, useApi, useCalendars, useSites, type Named, type Site } from '../lib/api';
import { isHr, useMe } from '../lib/auth';
import { downloadCsv, headerKey, normaliseDate, parseCsv } from '../lib/csv';
import { REQUEST_STATUS, StatusBadge, today, WEEKDAYS } from '../lib/format';

interface Holiday { id: string; date: string; name: string }

const weekdayOf = (ymd: string) => WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
const REFRESH = ['/holiday-calendars', '/sites', '/attendance', '/roster'];

/**
 * Holiday lists per office location: each site follows one calendar, so a calendar
 * is the holiday list of every location assigned to it.
 */
export function Holidays() {
  const me = useMe();
  const hr = isHr(me);
  const calendars = useCalendars().data ?? [];
  const sites = useSites().data ?? [];
  const [calendarId, setCalendarId] = useState('');
  const [siteId, setSiteId] = useState('');
  const site = sites.find((s) => s.id === siteId);
  const active = site ? site.holidayCalendarId ?? '' : calendarId || calendars[0]?.id || '';
  const calendar = calendars.find((c) => c.id === active);
  const onCalendar = sites.filter((s) => s.holidayCalendarId && s.holidayCalendarId === active);
  const { data, isLoading } = useApi<Holiday[]>(active ? `/holiday-calendars/${active}/holidays` : null, undefined, REFERENCE);
  const [modal, setModal] = useState<'calendar' | 'holiday' | 'import' | 'sites' | null>(null);
  const [f, set, setF] = useForm({ name: '', date: today() });
  const close = () => { setModal(null); setF({ name: '', date: today() }); };
  const addHoliday = useAction(() => post(`/holiday-calendars/${active}/holidays`, f), { invalidate: REFRESH, success: 'Holiday added', onSuccess: close });
  const remove = useAction((id: string) => del(`/holiday-calendars/${active}/holidays/${id}`), { invalidate: REFRESH, success: 'Holiday removed' });

  return (
    <div className="space-y-6">
      <PageHeader title="Holidays" subtitle="Each office location follows one holiday calendar. Changing a holiday recomputes that day for everyone at those locations."
        actions={hr && <>
          <Button variant="secondary" onClick={() => setModal('calendar')}>New calendar</Button>
          <Button variant="secondary" leftIcon={<Upload size={16} />} disabled={!active} onClick={() => setModal('import')}>Import CSV</Button>
          <Button leftIcon={<Plus size={16} />} disabled={!active} onClick={() => setModal('holiday')}>Add holiday</Button>
        </>}
        filters={
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <Select hideLabel label="Location" placeholder="Any location" containerClassName="w-full sm:w-56" value={siteId} onChange={(e) => setSiteId(e.target.value)}
              options={sites.map((s) => ({ value: s.id, label: s.name }))} />
            <Select hideLabel label="Calendar" containerClassName="w-full sm:w-72" value={active} disabled={Boolean(site)} onChange={(e) => setCalendarId(e.target.value)}
              options={calendars.map((c) => ({ value: c.id, label: c.name }))} />
          </div>
        } />

      {site && !site.holidayCalendarId ? (
        <Callout tone="warning" title={`${site.name} has no holiday calendar`}>
          Nobody there gets holidays until it follows one. Pick a calendar above (clear the location first) and use “Locations” to assign it.
        </Callout>
      ) : calendar && (
        <Card className="flex flex-wrap items-center gap-2">
          <MapPin size={16} className="text-brand" />
          <span className="text-sm font-semibold text-fg">{calendar.name}</span>
          <span className="text-sm text-fg-muted">is the holiday list for</span>
          {onCalendar.length ? onCalendar.map((s) => <Badge key={s.id} tone="brand">{s.name}</Badge>) : <span className="text-sm text-fg-subtle">no location yet</span>}
          {hr && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setModal('sites')}>Locations</Button>}
        </Card>
      )}

      <Panel>
        <DataTable rows={[...(data ?? [])].sort((a, b) => a.date.localeCompare(b.date))} getRowKey={(h) => h.id} loading={isLoading}
          empty={<EmptyState title={active ? 'No holidays in this calendar' : 'No holiday calendars yet'} description={hr ? 'Add holidays one by one or import a CSV.' : undefined} />}
          columns={[
            { key: 'date', header: 'Date', render: (h) => <span className="font-mono">{h.date.slice(0, 10)}</span> },
            { key: 'day', header: 'Day', render: (h) => weekdayOf(h.date.slice(0, 10)) },
            { key: 'name', header: 'Holiday' },
            { key: 'when', header: '', render: (h) => (h.date.slice(0, 10) < today() ? <StatusBadge value="EXPIRED" map={REQUEST_STATUS} /> : null) },
          ]}
          rowActions={hr ? (h) => <IconButton label="Remove holiday" icon={<Trash2 size={16} />} onClick={async () => { if (await confirmAction({ title: `Remove ${h.name}?`, message: 'That day is recomputed for everyone on this calendar.', confirmLabel: 'Remove holiday' })) remove.mutate(h.id); }} /> : undefined} />
      </Panel>

      {modal === 'holiday' && (
        <FormModal open onClose={close} title="Add holiday" submitLabel="Add holiday" saving={addHoliday.isPending} onSubmit={() => addHoliday.mutate()}>
          <TextField label="Name" required value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder="Labour Day" />
          <DateInput label="Date" required value={f.date} onChange={(e) => set('date')(e.target.value)} />
        </FormModal>
      )}
      {modal === 'calendar' && <CalendarForm sites={sites} onClose={close} onCreated={(id) => { setSiteId(''); setCalendarId(id); }} />}
      {modal === 'sites' && calendar && <CalendarSites calendar={calendar} sites={sites} calendars={calendars} onClose={close} />}
      {modal === 'import' && calendar && <ImportHolidays calendar={calendar} existing={data ?? []} onClose={close} />}
    </div>
  );
}

function SiteChecklist({ sites, calendars, selected, onChange, calendarId }: { sites: Site[]; calendars: Named[]; selected: string[]; onChange: (ids: string[]) => void; calendarId?: string }) {
  const [q, setQ] = useState('');
  const shown = sites.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  if (!sites.length) return <Callout tone="neutral" title="No locations yet">Add office locations under Settings → Sites.</Callout>;
  return (
    <div className="space-y-3">
      {sites.length > 6 && <SearchInput value={q} onChange={setQ} placeholder="Search locations" delay={0} />}
      <div className="max-h-72 space-y-2.5 overflow-y-auto">
        {shown.map((s) => {
          const other = s.holidayCalendarId && s.holidayCalendarId !== calendarId ? calendars.find((c) => c.id === s.holidayCalendarId)?.name : null;
          return (
            <Checkbox key={s.id} label={s.name} checked={selected.includes(s.id)}
              description={[s.timezone, other && `moves here from “${other}”`].filter(Boolean).join(' · ')}
              onChange={(e) => onChange(e.target.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id))} />
          );
        })}
      </div>
    </div>
  );
}

function CalendarForm({ sites, onClose, onCreated }: { sites: Site[]; onClose: () => void; onCreated: (id: string) => void }) {
  const calendars = useCalendars().data ?? [];
  const [name, setName] = useState('');
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const save = useAction(async () => {
    const c = await post<Named>('/holiday-calendars', { name });
    if (siteIds.length) await put(`/holiday-calendars/${c.id}/sites`, { siteIds });
    return c;
  }, { invalidate: REFRESH, success: 'Calendar added', onSuccess: (c) => { onCreated(c.id); onClose(); } });
  return (
    <FormModal open onClose={onClose} title="New holiday calendar" description="One holiday list, shared by the locations you pick." submitLabel="Add calendar" saving={save.isPending} onSubmit={() => save.mutate()}>
      <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="India — Maharashtra offices" />
      <p className="field-label">Locations that follow it</p>
      <SiteChecklist sites={sites} calendars={calendars} selected={siteIds} onChange={setSiteIds} />
    </FormModal>
  );
}

function CalendarSites({ calendar, sites, calendars, onClose }: { calendar: Named; sites: Site[]; calendars: Named[]; onClose: () => void }) {
  const [siteIds, setSiteIds] = useState(sites.filter((s) => s.holidayCalendarId === calendar.id).map((s) => s.id));
  const save = useAction(() => put(`/holiday-calendars/${calendar.id}/sites`, { siteIds }), { invalidate: REFRESH, success: 'Locations updated', onSuccess: onClose });
  return (
    <FormModal open onClose={onClose} title={`Locations on ${calendar.name}`} description="A location follows one calendar; the next two weeks are recomputed for its employees."
      submitLabel="Save locations" saving={save.isPending} onSubmit={() => save.mutate()}>
      <SiteChecklist sites={sites} calendars={calendars} selected={siteIds} onChange={setSiteIds} calendarId={calendar.id} />
    </FormModal>
  );
}

interface ParsedHoliday { line: number; raw: string; date: string | null; name: string; problem?: string }

const TEMPLATE = [['date', 'name'], ['2027-01-26', 'Republic Day'], ['15/08/2027', 'Independence Day']];

/** Parse → preview (dates normalised, problems flagged) → import only when every row is clean. */
function ImportHolidays({ calendar, existing, onClose }: { calendar: Named; existing: Holiday[]; onClose: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState('');
  const rows = useMemo<ParsedHoliday[]>(() => {
    if (!file) return [];
    const [header, ...body] = parseCsv(file.text);
    const keys = (header ?? []).map(headerKey);
    const dateCol = keys.findIndex((k) => ['date', 'holidaydate', 'day', 'on'].includes(k));
    const nameCol = keys.findIndex((k) => ['name', 'holiday', 'holidayname', 'occasion', 'description', 'title'].includes(k));
    if (dateCol < 0 || nameCol < 0) return [];
    const seen = new Set<string>();
    return body.map((r, i) => {
      const raw = (r[dateCol] ?? '').trim();
      const date = normaliseDate(raw);
      const name = (r[nameCol] ?? '').trim();
      const problem = !date ? `“${raw}” is not a date` : !name ? 'Name is empty' : name.length > 120 ? 'Name is longer than 120 characters' : seen.has(date) ? 'Date repeated in this file' : undefined;
      if (date) seen.add(date);
      return { line: i + 2, raw, date, name, problem };
    });
  }, [file]);
  const headerProblem = file && !rows.length ? 'The file needs a “date” and a “name” column (see the template).' : '';
  const bad = rows.filter((r) => r.problem);
  const have = new Set(existing.map((h) => h.date.slice(0, 10)));
  const replacing = rows.filter((r) => r.date && have.has(r.date)).length;

  const run = useAction(() => post<{ imported: number; created: number; updated: number }>(`/holiday-calendars/${calendar.id}/holidays/import`, { holidays: rows.map((r) => ({ date: r.date, name: r.name })) }), {
    invalidate: REFRESH, success: (r) => `${r.created} holidays added${r.updated ? `, ${r.updated} renamed` : ''}`, onSuccess: onClose,
  });

  return (
    <Modal open onClose={onClose} size="lg" title={`Import holidays into ${calendar.name}`} description="CSV with a date and a name column. Dates like 2027-01-26, 26/01/2027 or 26-Jan-2027 all work."
      headerActions={<Button size="sm" variant="ghost" leftIcon={<Download size={14} />} onClick={() => downloadCsv('holidays-template.csv', TEMPLATE)}>Template</Button>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!rows.length || bad.length > 0} loading={run.isPending} onClick={() => run.mutate()}>
          {rows.length ? `Import ${rows.length} holiday${rows.length === 1 ? '' : 's'}` : 'Import'}
        </Button>
      </>}>
      <div className="space-y-4 p-5 sm:p-6">
        <FileDropzone accept=".csv,text/csv" hint="CSV, up to 1,000 holidays" icon="file" file={file && { name: file.name }} error={error || headerProblem || undefined}
          onRemove={() => setFile(null)}
          onFiles={async ([f]) => { setError(''); if (f.size > 1_000_000) return setError('That file is over 1 MB.'); setFile({ name: f.name, text: await f.text() }); }} />
        {rows.length > 0 && (
          <Callout tone={bad.length ? 'danger' : 'success'} title={bad.length ? `${bad.length} of ${rows.length} rows need fixing` : `${rows.length} holidays are ready`}>
            {bad.length ? 'Fix them in the file and drop it in again.' : replacing ? `${replacing} date${replacing === 1 ? ' is' : 's are'} already in this calendar and will take the new name.` : 'Nothing in the calendar is overwritten.'}
          </Callout>
        )}
        {rows.length > 0 && (
          <div className="max-h-80 overflow-auto rounded-xl border border-line">
            <DataTable rows={bad.length ? bad : rows} getRowKey={(r) => String(r.line)}
              columns={[
                { key: 'l', header: 'Line', render: (r) => <span className="font-mono text-xs text-fg-subtle">{r.line}</span> },
                { key: 'd', header: 'Date', render: (r) => (r.date ? <span className="font-mono">{r.date}{r.date !== r.raw && <span className="ml-1 text-xs text-fg-subtle">(from {r.raw})</span>}</span> : <span className="text-danger-fg">{r.raw || 'empty'}</span>) },
                { key: 'w', header: 'Day', render: (r) => (r.date ? weekdayOf(r.date) : '') },
                { key: 'n', header: 'Holiday', render: (r) => r.name },
                { key: 's', header: '', render: (r) => (r.problem ? <Badge tone="danger">{r.problem}</Badge> : r.date && have.has(r.date) ? <Badge tone="warning">Renames existing</Badge> : <Badge tone="success">New</Badge>) },
              ]} />
          </div>
        )}
      </div>
    </Modal>
  );
}
