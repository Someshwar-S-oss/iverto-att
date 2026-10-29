import type { Tone } from '@iverto-org/core-ui';
import { dateTime } from './format';

/** LEAVE_APPROVED / LeaveRequest / logoUrl → "Leave approved" / "Leave request" / "Logo url". */
export const humanize = (s: string) => {
  const t = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const actionTone = (a: string): Tone =>
  /REJECT|DELET|DEACTIVAT|EXITED|SUSPEND|REMOVE|OFFBOARD|RELEASE/.test(a) ? 'danger'
    : /APPROV|CREATED|REACTIVAT|REGISTER|PROVISION|CLAIM/.test(a) ? 'success'
      : /PASSWORD|OVERRIDE|RESET|REEVALUATE/.test(a) ? 'warning' : 'neutral';

/** Payload as label/value rows; nested objects become "Branding · Logo url". */
export function auditFields(v: unknown, prefix = ''): { term: string; value: string }[] {
  if (v === null || v === undefined) return [];
  if (typeof v !== 'object' || Array.isArray(v)) return [{ term: prefix || 'Value', value: auditValue(v) }];
  return Object.entries(v).flatMap(([k, x]) => {
    const term = prefix ? `${prefix} · ${humanize(k)}` : humanize(k);
    return x && typeof x === 'object' && !Array.isArray(x) ? auditFields(x, term) : [{ term, value: auditValue(x) }];
  });
}
function auditValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? dateTime(v) : v;
  if (Array.isArray(v)) return v.length && v.every((x) => typeof x !== 'object' || x === null) ? v.map(auditValue).join(', ') : `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return `${Object.keys(v).length} fields`;
  return String(v);
}
