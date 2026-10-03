import { csvCell, toCsv } from './csv';

describe('CSV writer (§11.4)', () => {
  test('BOM, CRLF, header', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('﻿a,b\r\n1,x\r\n');
  });

  test('RFC 4180 quoting', () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  test.each(['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx'])('formula injection guarded: %j', (v) => {
    expect(csvCell(v).replace(/^"|"$/g, '').startsWith("'")).toBe(true);
  });

  test('numbers are not mangled, nulls are empty', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
});
