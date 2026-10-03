import { describe, expect, it } from 'vitest';
import { normaliseDate, parseCsv, toCsv } from './csv';

describe('csv', () => {
  it('round-trips quotes, commas and newlines', () => {
    const rows = [['code', 'name'], ['E1', 'Smith, "Jo"\nJr']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it('drops a BOM and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('normaliseDate', () => {
  it.each([
    ['2026-04-01', '2026-04-01'],
    ['2026/4/1', '2026-04-01'],
    ['01/04/2026', '2026-04-01'], // day first
    ['04/25/2026', '2026-04-25'], // middle part can only be a day
    ['1-4-26', '2026-04-01'],
    ['01-Apr-2026', '2026-04-01'],
    ['1 April 2026', '2026-04-01'],
    ['Apr 1, 2026', '2026-04-01'],
  ])('%s → %s', (raw, ymd) => expect(normaliseDate(raw)).toBe(ymd));

  it.each(['31/02/2026', '2026-13-01', 'soon', '', '1 Foo 2026'])('rejects %s', (raw) => expect(normaliseDate(raw)).toBeNull());
});
