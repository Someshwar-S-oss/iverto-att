import { Badge, type Tone } from '@iverto-org/core-ui';

type Look = { label: string; tone: Tone };

// Colour always comes with a word (core-ui voice rule).
export const DAY_STATUS: Record<string, Look> = {
  PRESENT: { label: 'Present', tone: 'success' },
  HALF_DAY: { label: 'Half day', tone: 'warning' },
  ABSENT: { label: 'Absent', tone: 'danger' },
  ON_LEAVE: { label: 'On leave', tone: 'info' },
  HALF_LEAVE: { label: 'Half leave', tone: 'info' },
  REMOTE: { label: 'Remote', tone: 'brand' },
  HOLIDAY: { label: 'Holiday', tone: 'neutral' },
  WEEKLY_OFF: { label: 'Weekly off', tone: 'neutral' },
  PENDING: { label: 'In progress', tone: 'neutral' },
};

export const LIVE_STATE: Record<string, Look> = {
  IN: { label: 'In', tone: 'success' },
  IN_LATE: { label: 'In (late)', tone: 'warning' },
  ON_BREAK: { label: 'On break', tone: 'info' },
  LEFT: { label: 'Left', tone: 'neutral' },
  NOT_YET_IN: { label: 'Not yet in', tone: 'neutral' },
  LATE_NOT_IN: { label: 'Late, not in', tone: 'orange' },
  ABSENT: { label: 'Absent', tone: 'danger' },
  ON_LEAVE: { label: 'On leave', tone: 'info' },
  REMOTE: { label: 'Remote', tone: 'brand' },
  OFF: { label: 'Off', tone: 'neutral' },
};

export const REQUEST_STATUS: Record<string, Look> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  // report jobs & tenants
  QUEUED: { label: 'Queued', tone: 'neutral' },
  RUNNING: { label: 'Generating', tone: 'info' },
  READY: { label: 'Ready', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'success' },
  INACTIVE: { label: 'Inactive', tone: 'neutral' },
  EXITED: { label: 'Exited', tone: 'neutral' },
  SUSPENDED: { label: 'Suspended', tone: 'danger' },
  PROVISIONING: { label: 'Provisioning', tone: 'warning' },
};

export function StatusBadge({ value, map = DAY_STATUS }: { value: string | null | undefined; map?: Record<string, Look> }) {
  if (!value) return <span className="text-fg-subtle">—</span>;
  const look = map[value.toUpperCase()] ?? { label: value, tone: 'neutral' as Tone };
  return <Badge tone={look.tone}>{look.label}</Badge>;
}

export const toOptions = (map: Record<string, Look>) => Object.entries(map).map(([value, { label }]) => ({ value, label }));

/** 485 → "8h 05m". */
export const hm = (minutes: number | null | undefined) =>
  minutes ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : '—';

/** An instant as wall-clock in the row's site timezone (§7.3). */
export function clock(iso: string | null | undefined, timeZone?: string, withDate = false) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(withDate ? { day: '2-digit', month: 'short' } : {}),
  }).format(new Date(iso));
}

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—';

/** Today as YYYY-MM-DD in the browser's timezone. */
export const today = () => new Date().toLocaleDateString('en-CA');
export const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const ROLES = ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'] as const;
export const ROLE_LABEL: Record<string, string> = { ADMIN: 'Administrator', HR: 'HR', MANAGER: 'Manager', EMPLOYEE: 'Employee', PLATFORM_ADMIN: 'Platform admin' };
