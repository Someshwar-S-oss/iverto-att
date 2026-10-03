/**
 * CSV for Excel (§11.4): UTF-8 with BOM, RFC 4180 quoting, and a
 * formula-injection guard — employee names are user input, so any cell
 * starting with = + - @ tab or CR is prefixed with ' so Excel shows it as text.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
