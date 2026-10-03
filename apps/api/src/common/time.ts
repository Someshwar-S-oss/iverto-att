import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

/**
 * Time conventions (D7):
 * - instants are `Date` (timestamptz, UTC);
 * - work dates are 'YYYY-MM-DD' strings in code and `@db.Date` in Postgres
 *   (Prisma maps those to a Date at UTC midnight);
 * - wall-clock "HH:mm" is always interpreted in a site timezone.
 */

export type Ymd = string;

export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar date of an instant in a timezone. */
export function localYmd(instant: Date, tz: string): Ymd {
  return formatInTimeZone(instant, tz, 'yyyy-MM-dd');
}

export function formatLocal(instant: Date | null | undefined, tz: string, pattern = 'HH:mm'): string | null {
  return instant ? formatInTimeZone(instant, tz, pattern) : null;
}

/** 'YYYY-MM-DD' → Date for a Prisma @db.Date column. */
export function dbDate(ymd: Ymd): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** Prisma @db.Date value → 'YYYY-MM-DD'. */
export function ymdOf(date: Date): Ymd {
  return date.toISOString().slice(0, 10);
}

export function addDays(ymd: Ymd, days: number): Ymd {
  const d = dbDate(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return ymdOf(d);
}

export function diffDays(from: Ymd, to: Ymd): number {
  return Math.round((dbDate(to).getTime() - dbDate(from).getTime()) / 86_400_000);
}

export function eachDay(from: Ymd, to: Ymd): Ymd[] {
  const out: Ymd[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(ymd: Ymd): number {
  return dbDate(ymd).getUTCDay();
}

/** The instant a local wall-clock time on a date occurs in a timezone (DST-aware). */
export function zonedInstant(ymd: Ymd, hhmm: string, tz: string): Date {
  return fromZonedTime(`${ymd}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}`, tz);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}

/** Leave year = April–March; `2026` is 1 Apr 2026 – 31 Mar 2027 (§8.2). */
export const LEAVE_YEAR_START_MONTH = 4;

export function leaveYearOf(ymd: Ymd): number {
  const [y, m] = ymd.split('-').map(Number);
  return m >= LEAVE_YEAR_START_MONTH ? y : y - 1;
}

export function leaveYearRange(year: number): { from: Ymd; to: Ymd } {
  return { from: `${year}-04-01`, to: `${year + 1}-03-31` };
}

export function monthRange(month: string): { from: Ymd; to: Ymd } {
  const from = `${month}-01`;
  const d = dbDate(from);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return { from, to: ymdOf(d) };
}
