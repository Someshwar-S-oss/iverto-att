// Friendly "when" for report schedules. The API stores a 5-field cron; the form
// only ever writes the four shapes below, and anything else stays as raw cron.

import { WEEKDAYS } from './format';

export type Repeat = 'daily' | 'weekdays' | 'weekly' | 'monthly';
export interface When { repeat: Repeat; time: string; days: number[]; dayOfMonth: number }

const pad = (n: number) => String(n).padStart(2, '0');
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

export function toCron(w: When): string {
  const [h, m] = w.time.split(':').map(Number);
  const dom = w.repeat === 'monthly' ? String(w.dayOfMonth) : '*';
  const dow = w.repeat === 'weekdays' ? '1-5' : w.repeat === 'weekly' ? [...w.days].sort().join(',') : '*';
  return `${m} ${h} ${dom} * ${dow}`;
}

/** Null when the cron is something the simple form can't show. */
export function fromCron(cron: string): When | null {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [m, h, dom, mon, dow] = p;
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h) || +m > 59 || +h > 23 || mon !== '*') return null;
  const base = { time: `${pad(+h)}:${pad(+m)}`, days: [1], dayOfMonth: 1 };
  if (dom === '*' && dow === '*') return { ...base, repeat: 'daily' };
  if (dom === '*' && dow === '1-5') return { ...base, repeat: 'weekdays' };
  if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) return { ...base, repeat: 'weekly', days: dow.split(',').map(Number) };
  if (/^\d+$/.test(dom) && +dom >= 1 && +dom <= 31 && dow === '*') return { ...base, repeat: 'monthly', dayOfMonth: +dom };
  return null;
}

export function describeCron(cron: string): string {
  const w = fromCron(cron);
  if (!w) return `Custom (${cron})`;
  const at = `at ${w.time}`;
  if (w.repeat === 'daily') return `Every day ${at}`;
  if (w.repeat === 'weekdays') return `Weekdays (Mon–Fri) ${at}`;
  if (w.repeat === 'weekly') return `Every ${w.days.map((d) => WEEKDAYS[d]).join(', ')} ${at}`;
  return `Monthly on the ${ordinal(w.dayOfMonth)} ${at}`;
}

// ICU still lists some zones by their pre-rename names; show the current ones.
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Rangoon': 'Asia/Yangon', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Europe/Kiev': 'Europe/Kyiv',
  'Africa/Asmera': 'Africa/Asmara', 'America/Godthab': 'America/Nuuk', 'Atlantic/Faeroe': 'Atlantic/Faroe', 'Pacific/Enderbury': 'Pacific/Kanton', 'Pacific/Ponape': 'Pacific/Pohnpei', 'Pacific/Truk': 'Pacific/Chuuk',
};
const known = (tz: string) => { try { return Boolean(new Intl.DateTimeFormat('en', { timeZone: tz })); } catch { return false; } };
const modern = (tz: string) => (RENAMED[tz] && known(RENAMED[tz]) ? RENAMED[tz] : tz);
/** The browser's own zone, by its current name. */
export const browserTimezone = () => modern(Intl.DateTimeFormat().resolvedOptions().timeZone);
let zones: { value: string; label: string; keywords: string }[] | undefined;
/** Every IANA zone the browser knows, labelled with its current UTC offset. */
export function timezoneOptions(current?: string) {
  zones ??= [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone').map(modern)])].map((tz) => {
    const offset = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts().find((x) => x.type === 'timeZoneName')?.value ?? '';
    return { value: tz, label: `${tz.replace(/_/g, ' ')} (${offset})`, keywords: `${tz} ${offset}` };
  });
  return current && !zones.some((z) => z.value === current) ? [{ value: current, label: current, keywords: current }, ...zones] : zones;
}
