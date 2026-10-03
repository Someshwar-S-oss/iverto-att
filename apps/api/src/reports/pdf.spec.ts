import { buildDoc, PdfRenderer } from './pdf';

const def = { type: 'timesheet', title: 'Timesheet', paper: { format: 'A4', landscape: true } } as never;
const meta = { orgName: 'Acme', period: '2026-09', filterChips: [], generatedBy: 'x', generatedAt: 'x', jobId: 'j', dataSha256: 'a'.repeat(64) };
const section = {
  columns: [{ key: 'date', label: 'Date' }, { key: 'status', label: 'Status', align: 'center' as const, badge: true }, { key: 'note', label: 'Remarks' }],
  rows: [{ date: '2026-09-01', status: 'PRESENT', note: 'Client visit — Guindy' }, { date: '2026-09-02', status: 'A', note: '' }],
  totals: { date: 'Total' },
};

describe('PDF renderer (§11.3)', () => {
  test('the longest text column stretches, the rest fit', () => {
    const doc = buildDoc(def, { kpis: [], sections: [section] }, meta) as any;
    expect(doc.content.at(-1).stack[0].table.widths).toEqual(['auto', 'auto', '*']);
  });

  test('renders a real PDF with embedded Poppins, no browser', async () => {
    const pdf = await new PdfRenderer().render(def, { kpis: [{ label: 'Present', value: 1, tone: 'success' }], sections: [section], signOff: true }, meta);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('Poppins');
  });
});
