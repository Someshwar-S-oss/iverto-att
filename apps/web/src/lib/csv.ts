// CSV in and out of the browser for the import wizards. The API parses the same dialect.

/** RFC 4180-ish parse (quotes, escaped quotes, CRLF); blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: string[][]) => rows.map((r) => r.map(cell).join(',')).join('\r\n');

/** BOM so Excel opens it as UTF-8. */
export function downloadCsv(filename: string, rows: string[][]) {
  const url = URL.createObjectURL(new Blob([`﻿${toCsv(rows)}\r\n`], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The date shapes spreadsheets produce → YYYY-MM-DD, or null if it isn't a real date.
 * Numeric dates are read day-first (DD/MM/YYYY) unless the middle part can only be a day.
 */
export function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let hit: RegExpMatchArray | null;
  if ((hit = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [y, m, d] = [+hit[1], +hit[2], +hit[3]];
  else if ((hit = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    [d, m, y] = [+hit[1], +hit[2], +hit[3]];
    if (m > 12 && d <= 12) [d, m] = [m, d];
    if (y < 100) y += 2000;
  } else if ((hit = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/,]+(\d{4})$/))) {
    [d, m, y] = [+hit[1], MONTHS.indexOf(hit[2].slice(0, 3).toLowerCase()) + 1, +hit[3]];
  } else if ((hit = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/))) {
    [m, d, y] = [MONTHS.indexOf(hit[1].slice(0, 3).toLowerCase()) + 1, +hit[2], +hit[3]];
  } else return null;
  const ymd = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${ymd}T00:00:00Z`);
  return m >= 1 && !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === ymd ? ymd : null;
}

/** "Employee Code", "employee_code", "EmployeeCode" → "employeecode": for matching spreadsheet headers. */
export const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
