import {
  Button, Card, Checkbox, ColorSwatchPicker, confirmAction, DateInput, Field, Modal, requestReason, SearchSelect, Select, TextField, Textarea, type SelectOption,
} from '@iverto-org/core-ui';
import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { post, useAction, useDepartments, useEmployeeOptions, useSites } from '../lib/api';
import { WEEKDAYS } from '../lib/format';

/** Tables sit in `<Card padding="none">` (core-ui page recipe). */
export const Panel = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <Card padding="none" className={`overflow-hidden ${className}`}>
    <div className="overflow-auto">{children}</div>
  </Card>
);

/** Page filter selects (`w-full sm:w-56`, core-ui convention). */
export function SiteSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useSites();
  return (
    <Select hideLabel label="Site" placeholder="All sites" containerClassName="w-full sm:w-56" value={value} onChange={(e) => onChange(e.target.value)}
      options={(data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
  );
}

export function DepartmentSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useDepartments();
  return (
    <Select hideLabel label="Department" placeholder="All departments" containerClassName="w-full sm:w-56" value={value} onChange={(e) => onChange(e.target.value)}
      options={(data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
  );
}

/**
 * The dropdown for modal forms: a type-to-search combobox (core-ui SearchSelect) in a labelled Field.
 * Takes Select-style options. `placeholder` doubles as the meaning of "nothing picked" ("No department").
 */
export function Pick({ label, value, onChange, options, placeholder, required, hint, avatar = false, emptyText }: {
  label: ReactNode; value: string; onChange: (v: string) => void; options: (SelectOption & { description?: string; keywords?: string })[];
  placeholder?: string; required?: boolean; hint?: ReactNode; avatar?: boolean; emptyText?: string;
}) {
  return (
    <Field label={label} required={required} hint={hint}>
      {({ id }) => (
        <div className="relative">
          <SearchSelect id={id} showAvatar={avatar} placeholder={placeholder ?? 'Search…'} value={value} onChange={onChange} emptyText={emptyText}
            options={options.filter((o) => !o.disabled).map((o) => ({ id: o.value, label: o.label, description: o.description, keywords: o.keywords }))} />
          {/* SearchSelect has no native input to mark required; this keeps the browser's "please fill in" check. */}
          {required && <input tabIndex={-1} aria-hidden required value={value} onChange={() => {}} className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0" />}
        </div>
      )}
    </Field>
  );
}

export function EmployeePicker({ value, onChange, label = 'Employee', required }: { value: string; onChange: (id: string) => void; label?: string; required?: boolean }) {
  const { data } = useEmployeeOptions();
  return (
    <Pick label={label} required={required} avatar placeholder="Search by name or code" value={value} onChange={onChange}
      options={(data?.items ?? []).map((e) => ({ value: e.id, label: e.fullName, description: e.employeeCode, keywords: e.email ?? '' }))} />
  );
}

/** Office locations, searchable, with each one's timezone underneath. */
export function SitePicker({ value, onChange, label = 'Location', required, placeholder = 'Search locations' }: { value: string; onChange: (id: string) => void; label?: string; required?: boolean; placeholder?: string }) {
  const { data } = useSites();
  return (
    <Pick label={label} required={required} placeholder={placeholder} value={value} onChange={onChange}
      options={(data ?? []).map((s) => ({ value: s.id, label: s.name, description: [s.address, s.timezone].filter(Boolean).join(' · ') }))} />
  );
}

/** A short form in a Modal, primary action last (core-ui). */
export function FormModal({
  open, onClose, title, description, onSubmit, saving, submitLabel, children, size,
}: {
  open: boolean; onClose: () => void; title: string; description?: string; onSubmit: () => void; saving?: boolean;
  submitLabel: string; children: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' | 'drawer';
}) {
  const id = useId();
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size={size}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form={id} loading={saving}>{submitLabel}</Button>
        </>
      }>
      <form id={id} className="space-y-4 p-5 sm:p-6" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        {children}
      </form>
    </Modal>
  );
}

/** Flat form state: `const [f, set] = useForm({...}); set('name')(value)`. */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [form, setForm] = useState(initial);
  const set = <K extends keyof T>(key: K) => (value: T[K]) => setForm((f) => ({ ...f, [key]: value }));
  return [form, set, setForm] as const;
}

// ── Declarative fields (Crud and a few hand-written forms) ──────────────────

export interface FieldSpec {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'time' | 'date' | 'color' | 'bool' | 'select' | 'weekdays' | 'textarea' | 'email' | 'employee';
  options?: SelectOption[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
  /** Hide unless this returns true for the current form. */
  when?: (form: Record<string, any>) => boolean;
}

const SWATCHES = ['#cd0447', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4b5563'];

export function Fields({ specs, form, set }: { specs: FieldSpec[]; form: Record<string, any>; set: (k: string) => (v: any) => void }) {
  return (
    <>
      {specs.filter((s) => !s.when || s.when(form)).map((s) => {
        const v = form[s.key];
        switch (s.type) {
          case 'bool':
            return <Checkbox key={s.key} label={s.label} description={s.hint} checked={Boolean(v)} onChange={(e) => set(s.key)(e.target.checked)} />;
          case 'select':
            return <Pick key={s.key} label={s.label} hint={s.hint} required={s.required} placeholder={s.placeholder ?? 'Search…'} options={s.options ?? []} value={v ?? ''} onChange={set(s.key)} />;
          case 'color':
            return <ColorSwatchPicker key={s.key} label={s.label} max={1} swatches={SWATCHES} value={v ? [v] : []} onChange={(c) => set(s.key)(c[c.length - 1] ?? null)} />;
          case 'weekdays':
            return (
              <Field key={s.key} label={s.label} hint={s.hint}>
                {() => (
                  <div className="flex flex-wrap gap-3">
                    {WEEKDAYS.map((d, i) => (
                      <Checkbox key={d} label={d} checked={(v ?? []).includes(i)}
                        onChange={(e) => set(s.key)(e.target.checked ? [...(v ?? []), i].sort() : (v ?? []).filter((x: number) => x !== i))} />
                    ))}
                  </div>
                )}
              </Field>
            );
          case 'employee':
            return <EmployeePicker key={s.key} label={s.label} required={s.required} value={v ?? ''} onChange={set(s.key)} />;
          case 'textarea':
            return <Textarea key={s.key} label={s.label} hint={s.hint} required={s.required} value={v ?? ''} onChange={(e) => set(s.key)(e.target.value)} />;
          case 'time':
          case 'date':
            return <DateInput key={s.key} mode={s.type} label={s.label} hint={s.hint} required={s.required} value={v ?? ''} onChange={(e) => set(s.key)(e.target.value)} />;
          default:
            return (
              <TextField key={s.key} label={s.label} hint={s.hint} required={s.required} placeholder={s.placeholder}
                type={s.type === 'number' ? 'number' : s.type === 'email' ? 'email' : 'text'} value={v ?? ''}
                onChange={(e) => set(s.key)(s.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
            );
        }
      })}
    </>
  );
}

/** Approve / reject / cancel for a request (`${path}/${id}/approve|reject|cancel`); reject asks why. */
export function Decide({ path, id, noun, canDecide, canCancel }: { path: string; id: string; noun: string; canDecide: boolean; canCancel?: boolean }) {
  const act = useAction(({ verb, note }: { verb: string; note?: string }) => post(`${path}/${id}/${verb}`, note ? { note } : {}), {
    invalidate: [path.split('/').slice(0, 2).join('/'), '/attendance'],
    success: `${noun} updated`,
  });
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className="flex gap-2" onClick={stop}>
      {canDecide && <Button size="sm" loading={act.isPending} onClick={() => act.mutate({ verb: 'approve' })}>Approve</Button>}
      {canDecide && (
        <Button size="sm" variant="danger" onClick={async () => {
          const note = await requestReason({ title: `Reject this ${noun.toLowerCase()}?`, message: 'The employee sees your reason.', confirmLabel: 'Reject', tone: 'danger', minLength: 3 });
          if (note) act.mutate({ verb: 'reject', note });
        }}>Reject</Button>
      )}
      {canCancel && (
        <Button size="sm" variant="ghost" onClick={async () => {
          if (await confirmAction({ title: `Cancel this ${noun.toLowerCase()}?`, confirmLabel: `Cancel ${noun.toLowerCase()}` })) act.mutate({ verb: 'cancel' });
        }}>Cancel</Button>
      )}
    </div>
  );
}

/** Drops '' so optional fields are omitted rather than sent empty (the API validates types strictly). */
export const clean = (form: Record<string, unknown>) => Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
