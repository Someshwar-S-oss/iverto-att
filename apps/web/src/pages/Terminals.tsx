import { Badge, Button, Callout, CenteredSpinner, DataTable, EmptyState, FileDropzone, IconButton, Modal, PageHeader, SearchInput, toast } from '@iverto-org/core-ui';
import { Copy, Link2, RefreshCw, ScanFace, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Crud } from '../components/Crud';
import { EmployeePicker, FormModal, Panel, Pick, useForm } from '../components/ui';
import { api, post, useAction, useApi, useEmployeeOptions, useSites } from '../lib/api';
import { useMe } from '../lib/auth';
import { dateTime } from '../lib/format';

interface Terminal { id: string; serialNo: string; name: string | null; gateName: string; direction: string; siteId: string; clockTimezone: string | null; status: string; lastSeenAt: string | null; registered: boolean; online: boolean; mappedUsers: number; unknownPunches: number }

const DIRECTION = [{ value: 'BOTH', label: 'Both ways (single terminal)' }, { value: 'IN', label: 'Entry only' }, { value: 'OUT', label: 'Exit only' }];
const label = (t: { name: string | null; serialNo: string; gateName: string }) => `${t.name ?? t.serialNo} · ${t.gateName}`;

export function Terminals() {
  const me = useMe();
  const sites = useSites().data ?? [];
  const [linking, setLinking] = useState<Terminal | null>(null);
  const sync = useAction((t: Terminal) => post(`/terminals/${t.id}/device/sync-enrolment`), { invalidate: ['/terminals'], success: 'Enrolment state checked against the device' });
  return (
    <>
      <Crud<Terminal> title="Terminals" subtitle="Provision a terminal by serial before it connects; unknown serials never get in." path="/terminals" noun="terminal"
        canDelete={me.role === 'ADMIN'}
        blank={{ serialNo: '', siteId: '', name: '', gateName: '', direction: 'BOTH', clockTimezone: '' }}
        toForm={(t) => ({ ...t, name: t.name ?? '', clockTimezone: t.clockTimezone ?? '' })}
        // PATCH does not take the serial; POST requires it.
        toBody={(f, isNew) => Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== '' && (isNew || k !== 'serialNo')))}
        columns={[
          { key: 'name', header: 'Terminal', render: (t) => <div><div className="font-semibold text-fg">{label(t)}</div><div className="font-mono text-xs text-fg-subtle">{t.serialNo}</div></div> },
          { key: 'site', header: 'Site', render: (t) => sites.find((s) => s.id === t.siteId)?.name ?? '—' },
          { key: 'dir', header: 'Direction', render: (t) => DIRECTION.find((d) => d.value === t.direction)?.label },
          { key: 'status', header: 'Status', render: (t) => <Badge dot tone={t.online ? 'success' : t.registered ? 'danger' : 'neutral'}>{t.online ? 'Online' : t.registered ? 'Offline' : 'Not yet connected'}</Badge> },
          { key: 'seen', header: 'Last seen', render: (t) => dateTime(t.lastSeenAt) },
          { key: 'users', header: 'People', align: 'right', render: (t) => t.mappedUsers },
          { key: 'unknown', header: 'Unknown punches', align: 'right', render: (t) => (t.unknownPunches ? <Badge tone="warning">{t.unknownPunches}</Badge> : '') },
        ]}
        actions={(t) => t.online && <>
          <IconButton label="Waiting to be linked" icon={<Link2 size={16} />} onClick={(e) => { e.stopPropagation(); setLinking(t); }} />
          <IconButton label="Check the device" icon={<RefreshCw size={16} />} onClick={(e) => { e.stopPropagation(); sync.mutate(t); }} />
        </>}
        fields={[
          { key: 'serialNo', label: 'Serial number', required: true, hint: 'From the device’s About screen', when: (f) => !f.id },
          { key: 'siteId', label: 'Site', type: 'select', required: true, options: sites.map((s) => ({ value: s.id, label: `${s.name} (${s.timezone})` })) },
          { key: 'name', label: 'Name', placeholder: 'North turnstile' },
          { key: 'gateName', label: 'Gate', required: true, hint: 'Terminals with the same gate name form one gate' },
          { key: 'direction', label: 'Direction', type: 'select', required: true, options: DIRECTION },
          { key: 'clockTimezone', label: 'Clock timezone', placeholder: 'Site timezone', hint: 'Only if the device clock runs in a different zone' },
        ]} />
      {linking && <Unclaimed terminal={linking} onClose={() => setLinking(null)} />}
    </>
  );
}

interface Slot { terminalUserId: number; deviceName: string | null; faceEnrolled: boolean; enrolledAt: string | null }

/** Keypad enrolments bound to nobody. Claiming retro-attributes their UNKNOWN punches (§5). */
function Unclaimed({ terminal, onClose }: { terminal: Terminal; onClose: () => void }) {
  const { data, isLoading } = useApi<{ slots: Slot[]; totalOnDevice: number }>(`/terminals/${terminal.id}/device/unclaimed`, undefined, { staleTime: 0, gcTime: 0 });
  const [photos, setPhotos] = useState<Record<number, string | null>>({});
  const [pick, setPick] = useState<Record<number, string>>({});
  const claim = useAction((slot: number) => post(`/terminals/${terminal.id}/users/${slot}/claim`, { employeeId: pick[slot] }), {
    invalidate: [`/terminals`, '/punches', '/attendance'], success: 'Linked — their earlier punches are being re-attributed',
  });
  const photo = async (slot: number) => {
    const r = await api<{ photoBase64: string | null }>(`/terminals/${terminal.id}/device/users/${slot}/photo`);
    setPhotos((p) => ({ ...p, [slot]: r.photoBase64 }));
  };
  return (
    <Modal open onClose={onClose} size="drawer" title="Waiting to be linked" description={`${label(terminal)} — people enrolled at the keypad without a reserved slot`}>
      <div className="space-y-3 p-5 sm:p-6">
        {isLoading ? <CenteredSpinner /> : !data?.slots.length ? <EmptyState title="Every slot on this terminal is linked" /> : data.slots.map((s) => (
          <div key={s.terminalUserId} className="space-y-3 rounded-2xl border border-line p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-fg">Slot <span className="font-mono">{s.terminalUserId}</span>{s.deviceName && ` · “${s.deviceName}”`}</div>
                <div className="text-xs text-fg-muted">{s.enrolledAt ? `Enrolled ${dateTime(s.enrolledAt)}` : 'Enrolled before this system'} · {s.faceEnrolled ? 'face on device' : 'no face yet'}</div>
              </div>
              {photos[s.terminalUserId] === undefined
                ? <Button size="sm" variant="secondary" onClick={() => void photo(s.terminalUserId)}>Show photo</Button>
                : photos[s.terminalUserId]
                  ? <img alt={`Slot ${s.terminalUserId}`} className="size-16 rounded-xl object-cover" src={`data:image/jpeg;base64,${photos[s.terminalUserId]}`} />
                  : <span className="text-xs text-fg-subtle">No photo kept</span>}
            </div>
            <EmployeePicker label="This is" value={pick[s.terminalUserId] ?? ''} onChange={(id) => setPick((p) => ({ ...p, [s.terminalUserId]: id }))} />
            <Button size="sm" disabled={!pick[s.terminalUserId]} loading={claim.isPending && claim.variables === s.terminalUserId} onClick={() => claim.mutate(s.terminalUserId)}>Link slot</Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

interface Coverage {
  devices: { id: string; serialNo: string; name: string | null; gateName: string }[];
  subjects: { subjectId: string; hasTemplate: boolean; templateCapturedAt: string | null; slots: { deviceId: string; terminalUserId: number; faceEnrolled: boolean }[] }[];
}

export function Enrollment() {
  const employees = useEmployeeOptions().data?.items ?? [];
  const { data: cov, isLoading } = useApi<Coverage>('/terminals/templates/coverage', undefined, { staleTime: 0 });
  const terminals = useApi<Terminal[]>('/terminals').data ?? [];
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<{ kind: 'photo' | 'reserve'; employeeId: string } | null>(null);
  const bySubject = new Map(cov?.subjects.map((s) => [s.subjectId, s]));
  const rows = employees.filter((e) => !q || `${e.fullName} ${e.employeeCode}`.toLowerCase().includes(q.toLowerCase()));
  const copy = useAction((employeeId: string) => {
    const s = bySubject.get(employeeId);
    const source = s?.hasTemplate ? undefined : s?.slots.find((x) => x.faceEnrolled)?.deviceId;
    return post<unknown[]>('/terminals/templates/distribute', { employeeIds: [employeeId], deviceIds: terminals.filter((t) => t.online).map((t) => t.id), sourceDeviceId: source, skipEnrolled: true });
  }, { invalidate: ['/terminals'], success: 'Face copied to every online terminal' });

  return (
    <div className="space-y-6">
      <PageHeader title="Face enrolment" subtitle="Who can scan at which terminal. Enrol once, then copy the face to the other terminals."
        filters={<SearchInput value={q} onChange={setQ} placeholder="Find an employee" />} />
      <Panel>
        <DataTable rows={rows} getRowKey={(e) => e.id} loading={isLoading} empty={<EmptyState title="No employees to enrol" />}
          columns={[
            { key: 'e', header: 'Employee', render: (e) => <div><div className="font-semibold text-fg">{e.fullName}</div><div className="font-mono text-xs text-fg-subtle">{e.employeeCode}</div></div> },
            { key: 't', header: 'Stored face', render: (e) => (bySubject.get(e.id)?.hasTemplate ? <Badge tone="success">Stored</Badge> : <Badge tone="neutral">None</Badge>) },
            { key: 'd', header: 'On terminals', render: (e) => {
              const slots = bySubject.get(e.id)?.slots ?? [];
              return slots.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {slots.map((s) => {
                    const d = cov?.devices.find((x) => x.id === s.deviceId);
                    return <Badge key={s.deviceId} tone={s.faceEnrolled ? 'success' : 'warning'}>{d ? label(d) : s.deviceId} #{s.terminalUserId}{s.faceEnrolled ? '' : ' · no face'}</Badge>;
                  })}
                </span>
              ) : <span className="text-fg-subtle">Not enrolled</span>;
            } },
          ]}
          rowActions={(e) => <>
            <IconButton label="Enrol from a photo" icon={<ScanFace size={16} />} onClick={() => setModal({ kind: 'photo', employeeId: e.id })} />
            <IconButton label="Reserve a slot for keypad enrolment" icon={<UserPlus size={16} />} onClick={() => setModal({ kind: 'reserve', employeeId: e.id })} />
            <IconButton label="Copy face to all terminals" icon={<Copy size={16} />} disabled={!bySubject.get(e.id)?.slots.some((s) => s.faceEnrolled)} onClick={() => copy.mutate(e.id)} />
          </>} />
      </Panel>
      {modal && <EnrolModal {...modal} name={employees.find((e) => e.id === modal.employeeId)?.fullName ?? ''} terminals={terminals.filter((t) => t.online)} onClose={() => setModal(null)} />}
    </div>
  );
}

/** Terminals take a JPEG under 32 KB: shrink and re-encode in the browser until it fits. */
async function toSmallJpeg(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  for (const [size, quality] of [[480, 0.85], [400, 0.8], [320, 0.75], [240, 0.7], [200, 0.6]] as const) {
    const scale = Math.min(1, size / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const b64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if ((b64.length * 3) / 4 < 32_000) return b64;
  }
  throw new Error('Could not get this photo under 32 KB — try a tighter crop of the face');
}

function EnrolModal({ kind, employeeId, name, terminals, onClose }: { kind: 'photo' | 'reserve'; employeeId: string; name: string; terminals: Terminal[]; onClose: () => void }) {
  const [f, set] = useForm({ deviceId: terminals[0]?.id ?? '', file: null as File | null });
  const [slot, setSlot] = useState<number | null>(null);
  const run = useAction(async () => {
    if (kind === 'reserve') return post<{ terminalUserId: number }>(`/terminals/${f.deviceId}/users`, { employeeId });
    return post(`/terminals/${f.deviceId}/enroll/photo`, { employeeId, photoBase64: await toSmallJpeg(f.file!) });
  }, {
    invalidate: ['/terminals'],
    onSuccess: (r) => {
      if (kind === 'reserve') setSlot((r as { terminalUserId: number }).terminalUserId);
      else { toast.success('Face enrolled', name); onClose(); }
    },
  });
  if (slot !== null) {
    return (
      <Modal open onClose={onClose} title={`Slot reserved for ${name}`} footer={<Button onClick={onClose}>Done</Button>}>
        <div className="space-y-3 p-5 text-center sm:p-6">
          <p className="text-sm text-fg-muted">At the terminal, enrol a face against user number</p>
          <p className="font-mono text-6xl font-bold text-brand">{slot}</p>
          <p className="text-sm text-fg-muted">then use “Check the device” on the Terminals page, and copy the face to other terminals from here.</p>
        </div>
      </Modal>
    );
  }
  return (
    <FormModal open onClose={onClose} title={kind === 'photo' ? `Enrol ${name} from a photo` : `Reserve a slot for ${name}`}
      submitLabel={kind === 'photo' ? 'Enrol face' : 'Reserve slot'} saving={run.isPending} onSubmit={() => run.mutate()}>
      {!terminals.length && <Callout tone="warning" title="No terminal is online" />}
      <Pick label="Terminal" required placeholder="Search terminals" options={terminals.map((t) => ({ value: t.id, label: label(t), description: t.serialNo }))} value={f.deviceId} onChange={set('deviceId')} />
      {kind === 'photo' && (
        <FileDropzone accept="image/jpeg,image/png" icon="image" hint="A clear, front-facing photo; it is shrunk to fit the terminal"
          file={f.file && { name: f.file.name }} onRemove={() => set('file')(null)} onFiles={([file]) => set('file')(file)} />
      )}
    </FormModal>
  );
}

