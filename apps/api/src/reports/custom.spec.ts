import { buildReport, CustomSpec, SOURCES, validateSpec } from './custom';

type Row = { name: string; dept: string; status: string; late: boolean; worked: number };
const src = {
  key: 't', label: 'T', description: '', row: 'one day', maxDays: 31, load: async () => [],
  fields: [
    { key: 'name', label: 'Employee', type: 'text', get: (r: Row) => r.name },
    { key: 'dept', label: 'Department', type: 'text', get: (r: Row) => r.dept },
    { key: 'status', label: 'Status', type: 'enum', options: [{ value: 'PRESENT', label: 'Present' }, { value: 'ABSENT', label: 'Absent' }], get: (r: Row) => r.status },
    { key: 'late', label: 'Late', type: 'bool', get: (r: Row) => r.late },
    { key: 'worked', label: 'Worked', type: 'minutes', get: (r: Row) => r.worked },
  ],
} as const;
const rows: Row[] = [
  { name: 'Asha', dept: 'Ops', status: 'PRESENT', late: true, worked: 480 },
  { name: 'Asha', dept: 'Ops', status: 'ABSENT', late: false, worked: 0 },
  { name: 'Ravi', dept: 'Eng', status: 'PRESENT', late: false, worked: 540 },
  { name: 'Ravi', dept: 'Eng', status: 'PRESENT', late: true, worked: 500 },
];
const run = (spec: Omit<CustomSpec, 'source'>) => buildReport(src as never, rows, { source: 't', ...spec });

describe('custom reports', () => {
  test('list mode: plain columns, conditions, formatting, default sort', () => {
    const d = run({ columns: [{ field: 'name' }, { field: 'status' }, { field: 'worked' }], where: [{ field: 'status', op: 'eq', value: 'PRESENT' }] });
    expect(d.sections[0].rows).toEqual([
      { c0: 'Asha', c1: 'Present', c2: '8:00' },
      { c0: 'Ravi', c1: 'Present', c2: '9:00' },
      { c0: 'Ravi', c1: 'Present', c2: '8:20' },
    ]);
    expect(d.sections[0].columns[1].badge).toBe(true);
    expect(d.kpis[0].value).toBe(3);
  });

  test('summary mode: group by plain columns, conditional counts, %, totals, sort and chart', () => {
    const d = run({
      columns: [
        { field: 'name' },
        { agg: 'count', where: [{ field: 'status', op: 'in', value: ['PRESENT'] }], label: 'Present' },
        { agg: 'percent', where: [{ field: 'late', op: 'isTrue' }], label: 'Late %' },
        { agg: 'sum', field: 'worked' },
      ],
      sort: { column: 3, dir: 'desc' },
      chart: true,
    });
    expect(d.sections[0].rows).toEqual([
      { c0: 'Ravi', c1: 2, c2: '50%', c3: '17:20' },
      { c0: 'Asha', c1: 1, c2: '50%', c3: '8:00' },
    ]);
    expect(d.sections[0].totals).toEqual({ c0: 'Total', c1: 3, c2: '50%', c3: '25:20' });
    expect(d.sections[0].columns[3].label).toBe('Total worked');
    expect(d.chart?.bars).toEqual([{ label: 'Ravi', value: 2 }, { label: 'Asha', value: 1 }]);
  });

  test('sections split the table, each with its own totals', () => {
    const d = run({ columns: [{ field: 'name' }, { agg: 'count' }], sectionBy: 'dept' });
    expect(d.sections.map((s) => [s.title, s.rows.length, s.totals?.c1])).toEqual([['Eng', 1, 2], ['Ops', 1, 2]]);
  });

  test('validation names the problem', () => {
    const v = (spec: Partial<CustomSpec>) => () => validateSpec({ source: 'days', columns: [{ field: 'employeeName' }], ...spec } as CustomSpec);
    expect(v({})).not.toThrow();
    expect(v({ source: 'payroll' })).toThrow(/Unknown data source/);
    expect(v({ columns: [{ field: 'salary' }] })).toThrow(/unknown field "salary"/);
    expect(v({ columns: [{ agg: 'sum', field: 'employeeName' }] })).toThrow(/can only sum a number/);
    expect(v({ columns: [{ agg: 'percent' }] })).toThrow(/needs a condition/);
    expect(v({ where: [{ field: 'status', op: 'gt', value: 1 }] })).toThrow(/can't be compared/);
  });

  test('every source field has a unique key', () => {
    for (const s of Object.values(SOURCES)) expect(new Set(s.fields.map((f) => f.key)).size).toBe(s.fields.length);
  });
});
