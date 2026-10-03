import { ActivityFeed, Badge, Breadcrumbs, Button, Callout, Card, CardHeader, CenteredSpinner, CopyField, DataTable, DescriptionList, EmptyState, PageHeader, requestReason, TextField } from '@iverto-org/core-ui';
import { LogIn, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { FormModal, Panel, useForm } from '../components/ui';
import { clearCache, post, useAction, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, REQUEST_STATUS, StatusBadge } from '../lib/format';

interface Tenant { id: string; name: string; slug: string; status: string; createdAt: string; suspendedAt: string | null; suspendedReason: string | null; employeeCount: number; terminalCount: number; terminalsOnline: number; lastPunchAt: string | null }
interface Temp { email: string; temporaryPassword: string }

/** Iverto staff only (§13.1). Platform admins do not see tenant attendance here. */
export function Tenants() {
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Tenant[]>('/platform/tenants');
  const [creating, setCreating] = useState(false);
  const [temp, setTemp] = useState<Temp | null>(null);
  return (
    <div className="space-y-6">
      <PageHeader title="Tenants" subtitle="Organisations on Iverto Attendance" actions={<Button leftIcon={<Plus size={16} />} onClick={() => setCreating(true)}>New tenant</Button>} />
      {temp && <Callout tone="success" title={`Tenant created — admin ${temp.email}`} onDismiss={() => setTemp(null)}><CopyField label="Temporary password (shown once)" value={temp.temporaryPassword} /></Callout>}
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(t) => t.id} loading={isLoading} onRowClick={(t) => navigate(`/platform/${t.id}`)} empty={<EmptyState title="No tenants yet" />}
          columns={[
            { key: 'n', header: 'Tenant', render: (t) => <div><div className="font-semibold text-fg">{t.name}</div><div className="font-mono text-xs text-fg-subtle">{t.slug}</div></div> },
            { key: 's', header: 'Status', render: (t) => <StatusBadge value={t.status} map={REQUEST_STATUS} /> },
            { key: 'e', header: 'Employees', align: 'right', render: (t) => t.employeeCount },
            { key: 't', header: 'Terminals online', align: 'right', render: (t) => <Badge tone={t.terminalsOnline < t.terminalCount ? 'warning' : 'success'}>{t.terminalsOnline} / {t.terminalCount}</Badge> },
            { key: 'p', header: 'Last punch', render: (t) => dateTime(t.lastPunchAt) },
          ]} />
      </Panel>
      {creating && <NewTenant onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); setTemp(t); }} />}
    </div>
  );
}

function NewTenant({ onClose, onCreated }: { onClose: () => void; onCreated: (t: Temp) => void }) {
  const [f, set] = useForm({ name: '', slug: '', siteName: '', timezone: 'Asia/Kolkata', fullName: '', email: '' });
  const save = useAction(() => post<{ admin: Temp }>('/platform/tenants', { name: f.name, slug: f.slug, site: { name: f.siteName, timezone: f.timezone }, admin: { fullName: f.fullName, email: f.email } }), {
    invalidate: ['/platform'], onSuccess: (r) => onCreated(r.admin),
  });
  return (
    <FormModal open size="drawer" onClose={onClose} title="New tenant" description="Creates the organisation, its first site, default policy, shift and leave types, and the first admin."
      submitLabel="Create tenant" saving={save.isPending} onSubmit={() => save.mutate()}>
      <TextField label="Organisation name" required value={f.name} onChange={(e) => set('name')(e.target.value)} />
      <TextField label="Slug" required pattern="[a-z0-9][a-z0-9-]{1,40}" hint="Lowercase letters, digits and dashes" value={f.slug} onChange={(e) => set('slug')(e.target.value.toLowerCase())} />
      <TextField label="First site" required value={f.siteName} onChange={(e) => set('siteName')(e.target.value)} />
      <TextField label="Site timezone (IANA)" required value={f.timezone} onChange={(e) => set('timezone')(e.target.value)} />
      <TextField label="Admin name" required value={f.fullName} onChange={(e) => set('fullName')(e.target.value)} />
      <TextField label="Admin email" type="email" required hint="One email belongs to one tenant" value={f.email} onChange={(e) => set('email')(e.target.value)} />
    </FormModal>
  );
}

interface TenantDetailData extends Tenant { sites: { id: string; name: string; timezone: string }[]; audit: { id: string; action: string; actorUserId: string | null; createdAt: string; payload: any }[] }

export function TenantDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { setOverride } = useAuth();
  const { data: t } = useApi<TenantDetailData>(`/platform/tenants/${id}`);
  const [temp, setTemp] = useState<Temp | null>(null);
  const act = useAction(({ path, body }: { path: string; body?: unknown }) => post<Partial<Temp>>(`/platform/tenants/${id}/${path}`, body), {
    invalidate: ['/platform'], success: 'Done',
    onSuccess: (r) => r?.temporaryPassword && setTemp(r as Temp),
  });
  if (!t) return <CenteredSpinner />;

  const openInside = () => {
    clearCache();
    setOverride(t.id);
    navigate('/live');
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<Breadcrumbs items={[{ label: 'Tenants', href: '/platform' }, { label: t.name }]} />} title={t.name} subtitle={t.slug}
        actions={<>
          {t.status === 'PROVISIONING' && <Button variant="secondary" loading={act.isPending} onClick={() => act.mutate({ path: 'retry-admin' })}>Finish setup</Button>}
          {t.status === 'ACTIVE' && <Button variant="secondary" onClick={() => act.mutate({ path: 'admin/reset-password' })}>Reset admin password</Button>}
          {t.status === 'SUSPENDED'
            ? <Button variant="secondary" onClick={() => act.mutate({ path: 'reactivate' })}>Reactivate</Button>
            : <Button variant="danger" onClick={async () => {
                const reason = await requestReason({ title: `Suspend ${t.name}?`, message: 'Users are locked out within a minute. Terminals keep buffering scans; nothing is lost.', confirmLabel: 'Suspend tenant', tone: 'danger', minLength: 3 });
                if (reason) act.mutate({ path: 'suspend', body: { reason } });
              }}>Suspend</Button>}
          <Button leftIcon={<LogIn size={16} />} onClick={openInside}>Open as admin</Button>
        </>} />
      {t.status === 'SUSPENDED' && <Callout tone="danger" title={`Suspended ${dateTime(t.suspendedAt)}`}>{t.suspendedReason}</Callout>}
      {temp && <Callout tone="success" title={`New temporary password for ${temp.email}`} onDismiss={() => setTemp(null)}><CopyField label="Shown once" value={temp.temporaryPassword} /></Callout>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <DescriptionList items={[
            { term: 'Status', value: <StatusBadge value={t.status} map={REQUEST_STATUS} /> },
            { term: 'Created', value: dateTime(t.createdAt) },
            { term: 'Sites', value: t.sites.map((s) => `${s.name} (${s.timezone})`).join(', '), wide: true },
          ]} />
        </Card>
        <Card>
          <CardHeader title="Platform audit trail" />
          <ActivityFeed empty={<p className="text-sm text-fg-muted">No platform actions yet.</p>}
            items={t.audit.map((a) => ({ id: a.id, actor: a.actorUserId?.slice(0, 8) ?? 'system', action: a.action.toLowerCase().replaceAll('_', ' '), time: dateTime(a.createdAt), detail: a.payload?.reason }))} />
        </Card>
      </div>
    </div>
  );
}
