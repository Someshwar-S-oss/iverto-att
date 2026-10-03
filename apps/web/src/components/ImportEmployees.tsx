import { Badge, Button, Callout, Checkbox, DataTable, FileDropzone, Modal } from '@iverto-org/core-ui';
import { ArrowLeft, Check, CheckCircle2, Download, FileSpreadsheet, MapPin, RefreshCw, Trash2, Upload, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { post, useAction, useDepartments, useEmployeeOptions, useSites } from '../lib/api';
import { downloadCsv, headerKey, normaliseDate, parseCsv, toCsv } from '../lib/csv';
import { today } from '../lib/format';
import { Pick, SitePicker } from './ui';

// ── The sheet ───────────────────────────────────────────────────────────────

type Key = 'employeeCode' | 'fullName' | 'departmentName' | 'designation' | 'managerCode' | 'email' | 'phone' | 'employmentType' | 'joinedOn' | 'mobilePunch';

const EMPLOYMENT = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'];
const MOBILE = ['NEVER', 'REMOTE_DAYS', 'ALWAYS'];

/** Every column the API's import understands (siteName comes from the location step). `aka` = header spellings we recognise. */
const COLUMNS: { key: Key; label: string; required?: boolean; rule: string; aka: string[] }[] = [
  { key: 'employeeCode', label: 'Employee code', required: true, rule: 'Unique, up to 40 characters', aka: ['code', 'empcode', 'employeeid', 'empid', 'staffid', 'empno', 'employeeno', 'employeenumber'] },
  { key: 'fullName', label: 'Full name', required: true, rule: 'As it should appear on reports', aka: ['name', 'employeename', 'employee', 'staffname'] },
  { key: 'joinedOn', label: 'Joining date', required: true, rule: 'YYYY-MM-DD (DD/MM/YYYY is converted)', aka: ['joiningdate', 'dateofjoining', 'doj', 'joined', 'joindate', 'startdate', 'datejoined'] },
  { key: 'departmentName', label: 'Department', rule: 'Must match an existing department', aka: ['department', 'dept', 'departmentname'] },
  { key: 'designation', label: 'Designation', rule: 'Free text', aka: ['title', 'jobtitle', 'position', 'role'] },
  { key: 'managerCode', label: 'Manager’s code', rule: 'An existing employee, or someone in this file', aka: ['manager', 'managerid', 'reportsto', 'reportingmanager', 'managercode'] },
  { key: 'email', label: 'Email', rule: 'Needed only for app sign-in', aka: ['emailaddress', 'mail', 'workemail', 'emailid'] },
  { key: 'phone', label: 'Phone', rule: 'Up to 30 characters', aka: ['mobile', 'phonenumber', 'mobilenumber', 'contact', 'contactnumber'] },
  { key: 'employmentType', label: 'Employment type', rule: EMPLOYMENT.join(' · '), aka: ['type', 'employment', 'employmenttype'] },
  { key: 'mobilePunch', label: 'Mobile punching', rule: MOBILE.join(' · '), aka: ['mobilepunching', 'mobilecheckin', 'mobilepunch'] },
];
const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label])) as Record<Key, string>;

function guessKey(header: string): Key | '' {
  const k = headerKey(header);
  return COLUMNS.find((c) => headerKey(c.key) === k || c.aka.includes(k))?.key ?? '';
}

type Row = Record<Key, string> & { _id: number };
interface CheckResult { total: number; valid: number; invalid: number; errors: { line: number; errors: { field: string; message: string }[] }[] }
type Problems = Map<number, { field: string; message: string }[]>; // by row _id

// ── Wizard ──────────────────────────────────────────────────────────────────

const STEPS = [
  { key: 'location', label: 'Location', icon: MapPin },
  { key: 'upload', label: 'Upload & map', icon: Upload },
  { key: 'review', label: 'Check & fix', icon: Wand2 },
  { key: 'done', label: 'Import', icon: CheckCircle2 },
] as const;
type Step = (typeof STEPS)[number]['key'];

function Stepper({ step }: { step: Step }) {
  const at = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="flex items-center gap-2 border-b border-line-soft px-5 py-4 sm:px-6">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
            i < at ? 'bg-success-soft text-success-fg' : i === at ? 'bg-brand text-on-brand shadow-soft' : 'bg-surface-subtle text-fg-subtle'}`}>
            {i < at ? <Check size={16} /> : <s.icon size={15} />}
          </span>
          <span className={`hidden truncate text-sm sm:block ${i === at ? 'font-semibold text-fg' : 'text-fg-muted'}`}>{s.label}</span>
          {i < STEPS.length - 1 && <span className={`h-px flex-1 ${i < at ? 'bg-success' : 'bg-line'}`} />}
        </li>
      ))}
    </ol>
  );
}

/**
 * Employee directory import, one location at a time:
 * location → upload (columns auto-mapped, remappable) → dry run with in-place fixes → import.
 * Import is only offered once a dry run of exactly the current rows passed.
 */
export function ImportEmployees({ onClose }: { onClose: () => void }) {
  const sites = useSites().data ?? [];
  const departments = useDepartments().data ?? [];
  const [step, setStep] = useState<Step>('location');
  const [siteId, setSiteId] = useState('');
  const [consent, setConsent] = useState(false);
  const [file, setFile] = useState<{ name: string; header: string[]; body: string[][] } | null>(null);
  const [fileError, setFileError] = useState('');
  const [mapping, setMapping] = useState<(Key | '')[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [version, setVersion] = useState(0); // bumps on every edit; a dry run is valid for one version
  const [checked, setChecked] = useState<{ version: number; result: CheckResult; problems: Problems } | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [created, setCreated] = useState(0);
  const site = sites.find((s) => s.id === siteId);

  const mapped = new Set(mapping.filter(Boolean));
  const missing = COLUMNS.filter((c) => c.required && !mapped.has(c.key));
  const doubled = COLUMNS.filter((c) => mapping.filter((m) => m === c.key).length > 1);

  const template = () => {
    const dept = departments[0]?.name ?? 'Operations';
    downloadCsv(`employees-${(site?.name ?? 'template').toLowerCase().replace(/\W+/g, '-')}.csv`, [
      COLUMNS.map((c) => c.key),
      ['EMP-1001', 'Asha Rao', today(), dept, 'Team Lead', '', 'asha.rao@company.com', '+91 98450 00001', 'FULL_TIME', 'NEVER'],
      ['EMP-1002', 'Vikram Shah', today(), dept, 'Technician', 'EMP-1001', '', '', 'CONTRACT', 'REMOTE_DAYS'],
    ]);
  };

  const readFile = async (f: File) => {
    setFileError('');
    if (f.size > 5_000_000) return setFileError('That file is over 5 MB.');
    const [header = [], ...body] = parseCsv(await f.text());
    if (!body.length) return setFileError('The file has no employee rows under the header.');
    if (body.length > 5000) return setFileError(`At most 5,000 employees per import — this file has ${body.length}.`);
    setFile({ name: f.name, header, body });
    // A siteName/location column stays unmapped: the location comes from step 1.
    setMapping(header.map((h) => guessKey(h)));
    setChecked(null);
  };

  const buildRows = () => {
    setRows(file!.body.map((r, i) => {
      const row = { ...Object.fromEntries(COLUMNS.map((c) => [c.key, ''])), _id: i } as Row;
      mapping.forEach((k, col) => { if (k) row[k] = (r[col] ?? '').trim(); });
      return row;
    }));
    setVersion((v) => v + 1);
    setStep('review');
  };

  const csvOf = (rs: Row[]) => toCsv([COLUMNS.map((c) => c.key), ...rs.map((r) => COLUMNS.map((c) => r[c.key]))]);
  const send = (commit: boolean) => post<CheckResult & { committed: boolean; createdIds?: string[] }>('/employees/import', { csv: csvOf(rows), siteId, biometricConsent: consent, commit });

  const dryRun = useAction(async () => ({ version, sent: rows.map((r) => r._id), result: await send(false) }), {
    onSuccess: ({ version: v, sent, result }) => {
      // The API reports CSV line numbers (header = line 1); map them back to stable row ids.
      const problems: Problems = new Map(result.errors.map((e) => [sent[e.line - 2], e.errors]));
      setChecked({ version: v, result, problems });
      setOnlyProblems(result.invalid > 0);
    },
  });
  const commit = useAction(() => send(true), {
    invalidate: ['/employees'],
    onSuccess: (r) => { setCreated(r.createdIds?.length ?? r.valid); setStep('done'); },
  });

  const fresh = checked?.version === version ? checked : null;
  const problems = checked?.problems ?? new Map();
  const edit = (id: number, key: Key, value: string) => { setRows((rs) => rs.map((r) => (r._id === id ? { ...r, [key]: value } : r))); setVersion((v) => v + 1); };
  const replaceAll = (key: Key, from: string, to: string) => { setRows((rs) => rs.map((r) => (r[key] === from ? { ...r, [key]: to } : r))); setVersion((v) => v + 1); };
  const removeRow = (id: number) => { setRows((rs) => rs.filter((r) => r._id !== id)); setVersion((v) => v + 1); };

  // Entering review runs the first dry run on its own.
  const autoRun = step === 'review' && !checked && rows.length > 0;
  useEffect(() => { if (autoRun) dryRun.mutate(); }, [autoRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const footer: Record<Step, ReactNode> = {
    location: <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={!siteId} onClick={() => setStep('upload')}>Continue</Button>
    </>,
    upload: <>
      <Button variant="ghost" leftIcon={<ArrowLeft size={16} />} onClick={() => setStep('location')}>Back</Button>
      <Button disabled={!file || missing.length > 0 || doubled.length > 0} onClick={buildRows}>Check {file ? `${file.body.length} rows` : 'rows'}</Button>
    </>,
    review: <>
      <Button variant="ghost" leftIcon={<ArrowLeft size={16} />} onClick={() => { setStep('upload'); setChecked(null); }}>Back</Button>
      <Button variant="secondary" leftIcon={<RefreshCw size={16} />} loading={dryRun.isPending} disabled={!rows.length} onClick={() => dryRun.mutate()}>Run dry run</Button>
      <Button disabled={!fresh || fresh.result.invalid > 0 || !rows.length} loading={commit.isPending} onClick={() => commit.mutate()}>
        Import {rows.length} employee{rows.length === 1 ? '' : 's'}
      </Button>
    </>,
    done: <Button onClick={onClose}>View employees</Button>,
  };

  return (
    <Modal open onClose={onClose} size="xl" closeOnBackdrop={false} title="Import employees" description={site ? `Into ${site.name}` : 'Add a whole location’s directory from a spreadsheet'} footer={footer[step]}>
      <Stepper step={step} />
      <div className="space-y-5 p-5 sm:p-6">
        {step === 'location' && (
          <>
            <SitePicker label="Which office location are these employees at?" required value={siteId} onChange={setSiteId} />
            {site && <p className="text-sm text-fg-muted">Everyone in the file joins <b className="text-fg">{site.name}</b> ({site.timezone}) and follows its holiday calendar. Import one file per location.</p>}
            <Checkbox appearance="boxed" label="Biometric consent was collected for everyone in this file" description="Recorded against each employee; required before enrolling faces (DPDP Act / GDPR)." checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <div className="rounded-2xl border border-line-soft bg-surface-subtle p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-fg"><FileSpreadsheet size={18} className="text-brand" /> The template</div>
                <Button size="sm" variant="secondary" leftIcon={<Download size={14} />} onClick={template}>Download template</Button>
              </div>
              <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                {COLUMNS.map((c) => (
                  <div key={c.key} className="flex min-w-0 gap-2">
                    <code className="shrink-0 font-mono text-xs font-semibold text-fg">{c.key}</code>
                    <span className="truncate text-fg-muted" title={c.rule}>{c.required && <Badge tone="brand" className="mr-1">required</Badge>}{c.rule}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {step === 'upload' && (
          <>
            <FileDropzone accept=".csv,text/csv" hint="CSV, up to 5,000 rows — Excel: File → Save As → CSV UTF-8" icon="file" error={fileError || undefined}
              file={file && { name: `${file.name} · ${file.body.length} rows` }} onRemove={() => { setFile(null); setMapping([]); }} onFiles={([f]) => void readFile(f)} />
            {file && (
              <div className="space-y-3">
                <div>
                  <h3 className="font-semibold text-fg">Match your columns</h3>
                  <p className="text-sm text-fg-muted">We matched what we recognised. Fix anything that’s wrong, or ignore columns you don’t need.</p>
                </div>
                {missing.length > 0 && <Callout tone="danger" title={`Missing: ${missing.map((c) => c.label).join(', ')}`}>Map a column to each, or add it to the file.</Callout>}
                {doubled.length > 0 && <Callout tone="danger" title={`Mapped twice: ${doubled.map((c) => c.label).join(', ')}`}>Each field can come from one column only.</Callout>}
                <div className="divide-y divide-line-soft rounded-2xl border border-line">
                  {file.header.map((h, col) => (
                    <div key={col} className="grid items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_auto_1fr]">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm font-semibold text-fg">{h || `Column ${col + 1}`}</p>
                        <p className="truncate text-xs text-fg-subtle">e.g. {file.body.slice(0, 3).map((r) => r[col]).filter(Boolean).join(', ') || 'empty'}</p>
                      </div>
                      <span className="hidden text-fg-subtle sm:block">→</span>
                      <Pick label={<span className="sr-only">Field for {h}</span>} placeholder="Ignore this column" value={mapping[col] ?? ''}
                        onChange={(v) => setMapping(mapping.map((m, i) => (i === col ? (v as Key | '') : m)))}
                        options={COLUMNS.map((c) => ({ value: c.key, label: c.label, description: c.required ? 'Required' : c.rule }))} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {step === 'review' && (
          <Review rows={rows} checked={checked} fresh={Boolean(fresh)} pending={dryRun.isPending} problems={problems} departments={departments}
            onlyProblems={onlyProblems} setOnlyProblems={setOnlyProblems} edit={edit} replaceAll={replaceAll} removeRow={removeRow} siteName={site?.name ?? ''} />
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success-fg"><CheckCircle2 size={30} /></span>
            <h3 className="text-xl font-bold text-fg">{created} employee{created === 1 ? '' : 's'} added to {site?.name}</h3>
            <p className="max-w-md text-sm text-fg-muted">They start on the default shift with the tenant’s weekly offs. Give app access from each profile, and enrol faces from Face enrolment.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Check & fix ─────────────────────────────────────────────────────────────

/** Fields whose bad values are usually the same typo many times over: fix them once for every row. */
const BULK: Key[] = ['departmentName', 'managerCode', 'employmentType', 'mobilePunch', 'joinedOn'];

function Review({ rows, checked, fresh, pending, problems, departments, onlyProblems, setOnlyProblems, edit, replaceAll, removeRow, siteName }: {
  rows: Row[]; checked: { result: CheckResult } | null; fresh: boolean; pending: boolean; problems: Problems; departments: { id: string; name: string }[];
  onlyProblems: boolean; setOnlyProblems: (v: boolean) => void; edit: (id: number, key: Key, v: string) => void; replaceAll: (key: Key, from: string, to: string) => void;
  removeRow: (id: number) => void; siteName: string;
}) {
  const employees = useEmployeeOptions().data?.items ?? [];
  const bad = rows.filter((r) => problems.get(r._id)?.length);
  const shown = (onlyProblems ? bad : rows).slice(0, 200);
  const errorOf = (r: Row, key: Key) => problems.get(r._id)?.find((e) => e.field === key)?.message;

  // Same field + same bad value = one decision ("“Enginering” in 4 rows → Engineering").
  const groups = useMemo(() => {
    const g = new Map<string, { key: Key; value: string; count: number; message: string }>();
    for (const r of bad) for (const e of problems.get(r._id) ?? []) {
      const key = e.field as Key;
      if (!BULK.includes(key)) continue;
      const id = `${key}\u0000${r[key]}`;
      g.set(id, { key, value: r[key], count: (g.get(id)?.count ?? 0) + 1, message: e.message });
    }
    return [...g.values()];
  }, [bad, problems]);
  const fixableDates = bad.filter((r) => errorOf(r, 'joinedOn') && normaliseDate(r.joinedOn));

  const choices = (key: Key) =>
    key === 'departmentName' ? departments.map((d) => ({ value: d.name, label: d.name }))
    : key === 'managerCode' ? [...employees.map((e) => ({ value: e.employeeCode, label: e.fullName, description: e.employeeCode })), ...rows.filter((r) => r.employeeCode).map((r) => ({ value: r.employeeCode, label: r.fullName || r.employeeCode, description: `${r.employeeCode} · in this file` }))]
    : key === 'employmentType' ? EMPLOYMENT.map((v) => ({ value: v, label: v.replace('_', ' ').toLowerCase() }))
    : key === 'mobilePunch' ? MOBILE.map((v) => ({ value: v, label: v.replace('_', ' ').toLowerCase() }))
    : [];

  if (!checked) return <Callout tone="info" title="Running a dry run…">Checking every row against {siteName}’s directory. Nothing is saved yet.</Callout>;
  const { result } = checked;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Rows', value: rows.length, tone: 'text-fg' },
          { label: 'Ready', value: fresh ? rows.length - bad.length : '—', tone: 'text-success-fg' },
          { label: 'Need fixing', value: bad.length, tone: bad.length ? 'text-danger-fg' : 'text-fg-subtle' },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-line-soft bg-surface-subtle px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{s.label}</p>
            <p className={`text-2xl font-bold ${s.tone}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {pending ? <Callout tone="info" title="Running the dry run…">Nothing is saved yet.</Callout>
        : !fresh ? <Callout tone="warning" title="You changed the data since the last dry run">Run the dry run again — import unlocks once every row passes.</Callout>
        : result.invalid === 0 ? <Callout tone="success" title={`Dry run passed: all ${rows.length} employees are ready for ${siteName}`}>Nothing has been saved yet. Import adds them all in one go.</Callout>
        : <Callout tone="danger" title={`${result.invalid} of ${result.total} rows didn’t pass the dry run`}>Fix them below — in bulk where the same value is wrong many times — or remove rows to skip them, then run the dry run again.</Callout>}

      {(groups.length > 0 || fixableDates.length > 0) && (
        <div className="space-y-3 rounded-2xl border border-line-soft bg-surface-subtle p-4">
          <div className="flex items-center gap-2 font-semibold text-fg"><Wand2 size={17} className="text-brand" /> Fix mismatches in bulk</div>
          {fixableDates.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2.5">
              <span className="text-sm text-fg">{fixableDates.length} joining date{fixableDates.length === 1 ? '' : 's'} like “{fixableDates[0].joinedOn}” can be converted to YYYY-MM-DD</span>
              <Button size="sm" onClick={() => fixableDates.forEach((r) => edit(r._id, 'joinedOn', normaliseDate(r.joinedOn)!))}>Convert dates</Button>
            </div>
          )}
          {groups.filter((g) => g.key !== 'joinedOn').map((g) => (
            <div key={`${g.key}:${g.value}`} className="grid items-center gap-2 rounded-xl bg-surface px-3 py-2.5 sm:grid-cols-[1fr_18rem]">
              <div className="min-w-0 text-sm">
                <span className="text-fg-muted">{LABEL[g.key]}</span> <b className="text-fg">“{g.value || 'empty'}”</b>{' '}
                <span className="text-fg-muted">in {g.count} row{g.count === 1 ? '' : 's'} — {g.message.replace(/^unknown \w+ /, 'not found ')}</span>
              </div>
              <Pick label={<span className="sr-only">Replace {g.value}</span>} avatar={g.key === 'managerCode'}
                placeholder={g.key === 'managerCode' || g.key === 'departmentName' ? 'Replace with… (or clear below)' : 'Replace with…'}
                value="" onChange={(v) => v && replaceAll(g.key, g.value, v)} options={choices(g.key)} />
              {(g.key === 'managerCode' || g.key === 'departmentName') && (
                <button type="button" className="justify-self-start text-xs font-semibold text-brand hover:underline sm:col-start-2" onClick={() => replaceAll(g.key, g.value, '')}>
                  Leave {LABEL[g.key].toLowerCase()} empty for these rows
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-fg">{onlyProblems ? 'Rows that need fixing' : 'All rows'}</h3>
        <Checkbox label="Only rows with problems" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
      </div>
      <div className="max-h-[26rem] overflow-auto rounded-2xl border border-line">
        <DataTable rows={shown} getRowKey={(r) => String(r._id)}
          empty={<p className="p-6 text-center text-sm text-fg-muted">{onlyProblems ? 'No problems left.' : 'No rows.'}</p>}
          columns={[
            { key: 'line', header: '#', render: (r) => <span className="font-mono text-xs text-fg-subtle">{r._id + 2}</span> },
            ...COLUMNS.map((c) => ({
              key: c.key,
              header: c.label,
              render: (r: Row) => {
                const err = errorOf(r, c.key);
                if (!err) return <span className={r[c.key] ? 'whitespace-nowrap text-fg' : 'text-fg-subtle'}>{r[c.key] || '—'}</span>;
                return (
                  <div className="min-w-36">
                    <input aria-label={`${c.label}, line ${r._id + 2}`} className="field field-invalid !py-1.5 text-sm" value={r[c.key]} onChange={(e) => edit(r._id, c.key, e.target.value)} />
                    <p className="mt-1 text-xs text-danger-fg">{err}</p>
                  </div>
                );
              },
            })),
            { key: 'x', header: '', render: (r) => <Button size="sm" variant="ghost" leftIcon={<Trash2 size={14} />} onClick={() => removeRow(r._id)}>Skip</Button> },
          ]} />
      </div>
      {(onlyProblems ? bad : rows).length > shown.length && <p className="text-xs text-fg-subtle">Showing the first {shown.length} — fix these and run the dry run again to see the rest.</p>}
    </div>
  );
}
