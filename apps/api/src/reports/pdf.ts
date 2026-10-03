import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import pdfmake from 'pdfmake';
import type { Column as PdfColumn, Content, CustomTableLayout, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { Column, ReportData, ReportDefinition, Section } from './definitions';

/** core-ui light palette; a PDF is paper, so there is no dark variant. */
const C = {
  brand: '#cd0447', brandTo: '#e91e63', body: '#1f2937', secondary: '#374151', muted: '#6b7280',
  line: '#e5e7eb', lineSoft: '#eef0f3', lineStrong: '#d1d5db', subtle: '#f9fafb', head: '#f3f4f6',
};
type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const TONE: Record<Tone, { fg: string; soft: string; accent: string }> = {
  success: { fg: '#047857', soft: '#ecfdf5', accent: '#059669' },
  warning: { fg: '#b45309', soft: '#fffbeb', accent: '#d97706' },
  danger: { fg: '#b91c1c', soft: '#fef2f2', accent: '#dc2626' },
  info: { fg: '#1d4ed8', soft: '#eff6ff', accent: '#2563eb' },
  neutral: { fg: '#4b5563', soft: '#f3f4f6', accent: '#9ca3af' },
};
const BADGE_TONE: Record<string, Tone> = {
  P: 'success', R: 'success', PRESENT: 'success', REMOTE: 'success', TERMINAL: 'neutral', MOBILE: 'info',
  A: 'danger', ABSENT: 'danger', 'A/½L': 'danger', MANUAL: 'warning', CORRECTION: 'warning',
  HD: 'warning', HALF_DAY: 'warning', L: 'info', '½L': 'info', ON_LEAVE: 'info', H: 'neutral', WO: 'neutral',
};

/** Points, portrait. */
const PAPER = { A4: [595.28, 841.89], A3: [841.89, 1190.55] } as const;
const MARGIN = 28;

// No network, no disk: fonts sit in pdfmake's in-memory fs, the logo is pre-fetched into `images`.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy(() => false);
let fontsReady = false;
function registerFonts() {
  if (fontsReady) return;
  // TTF, not core-ui's woff2: fontkit can't subset woff2. Full Poppins covers Latin + Devanagari.
  // pdfmake 0.3 takes font *paths*; its in-memory fs keeps them off the disk policy.
  const vfs = (pdfmake as unknown as { virtualfs: { writeFileSync(path: string, data: Buffer): void } }).virtualfs;
  const font = (file: string) => {
    vfs.writeFileSync(file, readFileSync(join(__dirname, '../../assets/fonts', file)));
    return file;
  };
  const [regular, bold] = [font('Poppins-Regular.ttf'), font('Poppins-SemiBold.ttf')];
  pdfmake.setFonts({ Poppins: { normal: regular, bold, italics: regular, bolditalics: bold } });
  fontsReady = true;
}

/** Tenant logo as a data URL, or null (→ wordmark). https PNG/JPEG only, small, fast. */
async function fetchLogo(url?: string | null): Promise<string | null> {
  if (!url || !url.startsWith('https://')) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/^image\/(png|jpe?g)$/.test(type.split(';')[0])) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= 2 * 1024 * 1024 ? `data:${type};base64,${buf.toString('base64')}` : null;
  } catch {
    return null;
  }
}

export interface RenderMeta {
  orgName: string;
  logoUrl?: string | null;
  period: string;
  filterChips: string[];
  generatedBy: string;
  generatedAt: string;
  jobId: string;
  dataSha256: string;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const hline = (w: number, color: string, width = 0.5): Content => ({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: w, y2: 0, lineWidth: width, lineColor: color }] });

function band(def: ReportDefinition, meta: RenderMeta, width: number, hasLogo: boolean): Content {
  const H = 60;
  const brand: PdfColumn = hasLogo
    ? {
        width: 132,
        stack: [
          { canvas: [{ type: 'rect', x: 0, y: 0, w: 132, h: 40, r: 6, color: '#ffffff' }] },
          { image: 'logo', fit: [116, 30], alignment: 'center', margin: [0, -35, 0, 0] },
        ],
      }
    : { width: 'auto', text: 'iverto', fontSize: 17, bold: true, color: '#ffffff', margin: [0, 8, 0, 0] };
  return {
    stack: [
      { canvas: [{ type: 'rect', x: 0, y: 0, w: width, h: H, r: 8, color: C.brand, linearGradient: [C.brand, C.brandTo] }] },
      {
        columns: [
          {
            width: '*',
            stack: [
              { text: def.title, fontSize: 16, bold: true, color: '#ffffff' },
              { text: `${meta.orgName}   ·   ${meta.period}`, fontSize: 9, color: '#ffe4ec', margin: [0, 2, 0, 0] },
            ],
          },
          brand,
        ],
        margin: [16, -H + 10, 10, 0],
      },
    ],
    margin: [0, 0, 0, 10],
  };
}

function kpis(items: ReportData['kpis'], width: number, a3: boolean): Content[] {
  if (!items.length) return [];
  const rows = Math.ceil(items.length / Math.max(1, Math.floor(width / 92)));
  const perRow = Math.ceil(items.length / rows);
  const card = (k: ReportData['kpis'][number]): PdfColumn => {
    const tone = k.tone ? TONE[k.tone] : null;
    return {
      width: '*',
      table: {
        widths: ['*'],
        body: [[{
          stack: [
            { text: str(k.value), fontSize: a3 ? 14 : 15, bold: true, color: tone?.accent ?? C.body },
            { text: k.label, fontSize: 7.5, color: C.muted },
          ],
          fillColor: C.subtle,
          margin: [8, 5, 6, 5],
        }]],
      },
      layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 2.5 : 0), vLineColor: () => tone?.accent ?? C.lineStrong },
    };
  };
  const out: Content[] = [];
  for (let i = 0; i < items.length; i += perRow) {
    const slice = items.slice(i, i + perRow).map(card);
    while (slice.length < perRow) slice.push({ width: '*', text: '' });
    out.push({ columns: slice, columnGap: 8, margin: [0, 0, 0, 8] });
  }
  return out;
}

function chart(c: NonNullable<ReportData['chart']>, width: number): Content {
  const max = Math.max(1, ...c.bars.map((b) => b.value));
  const barW = width * 0.55;
  return {
    stack: [
      { text: c.title, fontSize: 10, bold: true, margin: [0, 6, 0, 4] },
      {
        table: {
          widths: [width * 0.3, barW, '*'],
          body: c.bars.map((b): TableCell[] => [
            { text: b.label, fontSize: 8, color: C.secondary, noWrap: true },
            { canvas: [{ type: 'rect', x: 0, y: 1.5, w: Math.max(2, (b.value / max) * barW), h: 9, r: 2, color: C.brand }] },
            { text: str(b.value), fontSize: 8, color: C.muted },
          ]),
        },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingTop: () => 2, paddingBottom: () => 2, paddingLeft: () => 0, paddingRight: () => 6 },
      },
    ],
    margin: [0, 0, 0, 10],
  };
}

function cell(c: Column, v: unknown): TableCell {
  const text = str(v);
  const alignment = c.align ?? 'left';
  if (!c.badge || !text) return { text, alignment };
  const tone = TONE[BADGE_TONE[text.replace('*', '')] ?? 'neutral'];
  return { text, alignment: c.align ?? 'center', color: tone.fg, fillColor: tone.soft };
}

function table(s: Section, a3: boolean): Content {
  const header: TableCell[] = s.columns.map((c) => ({ text: c.label, bold: true, color: C.secondary, fillColor: C.head, alignment: c.align ?? 'left', fontSize: a3 ? 6.5 : 7.5 }));
  const body: TableCell[][] = s.rows.map((r) => s.columns.map((c) => cell(c, r[c.key])));
  const foot: TableCell[][] = s.totals ? [s.columns.map((c) => ({ text: str(s.totals![c.key]), bold: true, alignment: c.align ?? 'left' }))] : [];
  const rows = 1 + body.length + foot.length;
  const pad = a3 ? 3.5 : 5;
  // Grids (muster roll) spread the day/total columns evenly; otherwise the text column with the longest value takes the slack.
  const wide = s.columns.length > 12;
  const chars = (c: Column) => s.rows.reduce((n, r) => Math.max(n, str(r[c.key]).length), c.label.length);
  const stretch = s.columns.filter((c) => !c.align).sort((a, b) => chars(b) - chars(a))[0];
  const widths = s.columns.map((c) => (wide ? (c.align ? '*' : 'auto') : !stretch || c === stretch ? '*' : 'auto'));
  const layout: CustomTableLayout = {
    hLineWidth: (i) => (i === 0 ? 0 : i === 1 || (foot.length && i === rows - 1) ? 0.8 : 0.5),
    hLineColor: (i) => (i === 1 || (foot.length && i === rows - 1) ? C.lineStrong : C.lineSoft),
    vLineWidth: () => 0,
    fillColor: (i) => (i > 1 && i <= body.length && i % 2 === 0 ? C.subtle : null),
    paddingLeft: () => pad,
    paddingRight: () => pad,
    paddingTop: () => (a3 ? 2.5 : 3.5),
    paddingBottom: () => (a3 ? 2.5 : 3.5),
  };
  return {
    table: { headerRows: 1, dontBreakRows: true, widths, body: [header, ...body, ...foot] },
    layout,
    margin: [0, 0, 0, 10],
  };
}

function signOff(width: number): Content {
  const w = (width - 80) / 3;
  return {
    columns: ['Employee signature', 'Manager signature', 'Date'].map((l) => ({
      stack: [hline(w, C.muted, 0.6), { text: l, fontSize: 7.5, color: C.muted, margin: [0, 3, 0, 0] }],
    })),
    columnGap: 40,
    margin: [0, 28, 0, 6],
    unbreakable: true,
  };
}

export function buildDoc(def: ReportDefinition, data: ReportData, meta: RenderMeta, logo: string | null = null): TDocumentDefinitions {
  const a3 = def.paper.format === 'A3';
  const [pw, ph] = PAPER[def.paper.format];
  const width = (def.paper.landscape ? ph : pw) - 2 * MARGIN;
  // Muster rolls and timesheets are per-group documents: each group starts a page.
  const breakGroups = def.type === 'muster-roll' || def.type === 'timesheet';
  const sections = data.sections.filter((s) => s.rows.length);

  const content: Content[] = [
    band(def, meta, width, Boolean(logo)),
    ...(meta.filterChips.length ? [{ text: meta.filterChips.join('   ·   '), fontSize: 7.5, color: C.muted, margin: [2, 0, 0, 10] } as Content] : []),
    ...kpis(data.kpis, width, a3),
    ...(data.chart?.bars.length ? [chart(data.chart, width)] : []),
    ...(sections.length
      ? sections.map((s, i): Content => ({
          stack: [
            ...(s.title ? [{ text: s.title, fontSize: 10.5, bold: true, margin: [0, 6, 0, 5] } as Content] : []),
            table(s, a3),
            ...(data.signOff ? [signOff(width)] : []),
          ],
          pageBreak: breakGroups && i > 0 ? 'before' : undefined,
        }))
      : [{ text: 'No records match these filters.', alignment: 'center', color: C.muted, margin: [0, 40, 0, 0] } as Content]),
  ];

  return {
    pageSize: def.paper.format,
    pageOrientation: def.paper.landscape ? 'landscape' : 'portrait',
    pageMargins: [MARGIN, 36, MARGIN, 40],
    info: { title: def.title, author: meta.orgName, subject: meta.period, creator: 'Iverto' },
    images: logo ? { logo } : undefined,
    defaultStyle: { font: 'Poppins', fontSize: a3 ? 7 : 8.5, color: C.body, lineHeight: 1.15 },
    header: (page) =>
      page === 1
        ? null
        : {
            columns: [
              { text: def.title, bold: true, color: C.brand },
              { text: `${meta.orgName}   ·   ${meta.period}`, alignment: 'right', color: C.muted },
            ],
            fontSize: 7.5,
            margin: [MARGIN, 16, MARGIN, 0],
          },
    footer: (page, pages) => ({
      stack: [
        hline(width, C.line),
        {
          columns: [
            { width: 'auto', text: [{ text: 'iverto', bold: true, color: C.brand }, `   ·   Page ${page} of ${pages}`] },
            {
              width: '*',
              alignment: 'right',
              text: `Generated by ${meta.generatedBy} · ${meta.generatedAt} · Job ${meta.jobId} · SHA-256 ${meta.dataSha256.slice(0, 16)}…`,
            },
          ],
          fontSize: 6.5,
          color: C.muted,
          margin: [0, 5, 0, 0],
        },
      ],
      margin: [MARGIN, 12, MARGIN, 0],
    }),
    content,
  };
}

/** Pure-JS PDF (pdfmake): no browser, tens of MB per job (§11.3). */
@Injectable()
export class PdfRenderer {
  async render(def: ReportDefinition, data: ReportData, meta: RenderMeta): Promise<Buffer> {
    registerFonts();
    return pdfmake.createPdf(buildDoc(def, data, meta, await fetchLogo(meta.logoUrl))).getBuffer();
  }
}
