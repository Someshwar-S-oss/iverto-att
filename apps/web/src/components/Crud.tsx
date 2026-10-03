import { Button, confirmAction, DataTable, EmptyState, IconButton, PageHeader, type Column } from '@iverto-org/core-ui';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { del, patch, post, REFERENCE, useAction, useApi } from '../lib/api';
import { clean, Fields, FormModal, Panel, useForm, type FieldSpec } from './ui';

interface CrudProps<Row> {
  title: string;
  subtitle?: string;
  /** List + create path; edit/delete go to `${path}/:id`. */
  path: string;
  noun: string;
  columns: Column<Row>[];
  fields: FieldSpec[];
  /** Blank form for "Add"; its keys are also the only ones sent. */
  blank: Record<string, unknown>;
  canEdit?: boolean;
  canDelete?: boolean;
  /** Row → form values for "Edit" (defaults to the row itself). */
  toForm?: (row: Row) => Record<string, unknown>;
  toBody?: (form: Record<string, any>, isNew: boolean) => unknown;
  /** Extra row actions before edit/delete. */
  actions?: (row: Row) => ReactNode;
  /** Rendered above the table (e.g. a filter). */
  above?: ReactNode;
  /** Settings sections render without their own page title. */
  embedded?: boolean;
}

/**
 * List + add/edit modal + delete for the reference-data screens (sites, shifts,
 * leave types, policies…). Each is the same shape; only the fields differ.
 */
export function Crud<Row extends { id: string }>({
  title, subtitle, path, noun, columns, fields, blank, canEdit = true, canDelete = true, toForm, toBody = (f) => clean(f), actions, above, embedded,
}: CrudProps<Row>) {
  const { data, isLoading } = useApi<Row[]>(path, undefined, REFERENCE);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [form, , setForm] = useForm<Record<string, any>>(blank);
  const set = (k: string) => (v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  // Only the form's own keys go up: the API rejects unknown properties (forbidNonWhitelisted).
  const body = (f: Record<string, any>) => toBody(Object.fromEntries(Object.keys(blank).map((k) => [k, f[k]])), editing === 'new');
  const save = useAction((f: Record<string, any>) => (editing === 'new' ? post(path, body(f)) : patch(`${path}/${(editing as Row).id}`, body(f))), {
    invalidate: [path],
    success: `${noun[0].toUpperCase()}${noun.slice(1)} saved`,
    onSuccess: () => setEditing(null),
  });
  const remove = useAction((row: Row) => del(`${path}/${row.id}`), { invalidate: [path], success: `${noun[0].toUpperCase()}${noun.slice(1)} removed` });

  const open = (row: Row | 'new') => {
    setForm(row === 'new' ? blank : { ...blank, ...(toForm ? toForm(row) : row) });
    setEditing(row);
  };

  const addButton = canEdit ? <Button leftIcon={<Plus size={16} />} onClick={() => open('new')}>Add {noun}</Button> : undefined;

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-fg">{title}</h2>
            {subtitle && <p className="text-sm text-fg-muted">{subtitle}</p>}
          </div>
          {addButton}
        </div>
      ) : (
        <PageHeader title={title} subtitle={subtitle} actions={addButton} />
      )}
      {above}
      <Panel>
        <DataTable
          columns={columns}
          rows={data ?? []}
          getRowKey={(r) => r.id}
          loading={isLoading}
          onRowClick={canEdit ? open : undefined}
          empty={<EmptyState title={`No ${noun}s yet`} description={canEdit ? `Add the first ${noun} to get started.` : undefined} action={addButton} />}
          rowActions={(row) => (
            <>
              {actions?.(row)}
              {canEdit && <IconButton label={`Edit ${noun}`} icon={<Pencil size={16} />} onClick={(e) => { e.stopPropagation(); open(row); }} />}
              {canEdit && canDelete && (
                <IconButton label={`Remove ${noun}`} icon={<Trash2 size={16} />}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (await confirmAction({ title: `Remove this ${noun}?`, message: 'This cannot be undone.', confirmLabel: `Remove ${noun}` })) remove.mutate(row);
                  }} />
              )}
            </>
          )}
        />
      </Panel>
      <FormModal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? `Add ${noun}` : `Edit ${noun}`}
        submitLabel={editing === 'new' ? `Add ${noun}` : 'Save changes'} saving={save.isPending} onSubmit={() => save.mutate(form)}>
        <Fields specs={fields} form={form} set={set} />
      </FormModal>
    </div>
  );
}
