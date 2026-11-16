// Rendus des rapports : CSV (UTF-8 BOM, séparateur « ; », virgule décimale pour Excel FR), Excel (.xlsx) et PDF (pdfkit).
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export const DISCLAIMER = "Rapport de gestion généré par MHFac. Il ne constitue pas une comptabilité générale certifiée ni une déclaration fiscale ; à valider avec un professionnel.";
const frNum = (v, type) => { if (v === null || v === undefined || v === '') return ''; const s = String(v); return type === 'money' ? s.replace('.', ',') : type === 'qty' ? String(Number(s)).replace('.', ',') : s; };
const frDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : v ?? '');
const cell = (v, c) => (c.type === 'date' ? frDate(v) : c.type === 'money' || c.type === 'qty' ? frNum(v, c.type) : v ?? '');
// Neutralise l'injection de formules (=, +, -, @) dans les cellules texte exportées.
const safe = (v, c) => { if (c.type !== 'text' && c.type !== undefined) return v; const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };

export function toCsv(report) {
  const esc = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [report.columns.map((c) => esc(c.label)).join(';')];
  for (const r of report.rows) lines.push(report.columns.map((c) => esc(c.type === 'text' ? safe(r[c.key], c) : cell(r[c.key], c))).join(';'));
  const tot = report.totals ?? {};
  if (Object.keys(tot).length) lines.push(report.columns.map((c, i) => esc(i === 0 ? 'TOTAL' : tot[c.key] !== undefined ? cell(tot[c.key], c) : '')).join(';'));
  for (const t of report.extraTotals ?? []) lines.push(`${esc(t.label)};${esc(frNum(t.value, 'money'))}`);
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

export async function toXlsx(report, meta) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'MHFac'; wb.created = new Date();
  const ws = wb.addWorksheet(report.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.addRow([`${meta.company} — ${report.title}`]).font = { bold: true, size: 14 };
  ws.addRow([meta.periodLabel]); ws.addRow([DISCLAIMER]).font = { italic: true, size: 9, color: { argb: 'FF666666' } };
  const head = ws.addRow(report.columns.map((c) => c.label)); head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }; c.alignment = { vertical: 'middle', wrapText: true }; });
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  for (const r of report.rows) ws.addRow(report.columns.map((c) => (c.type === 'money' || c.type === 'qty' || c.type === 'number' ? num(r[c.key]) : c.type === 'date' && r[c.key] ? new Date(`${r[c.key]}T00:00:00Z`) : safe(r[c.key], c))));
  const tot = report.totals ?? {};
  if (Object.keys(tot).length) { const t = ws.addRow(report.columns.map((c, i) => (i === 0 ? 'TOTAL' : tot[c.key] !== undefined ? num(tot[c.key]) : null))); t.font = { bold: true }; t.eachCell((c) => { c.border = { top: { style: 'thin' } }; }); }
  for (const t of report.extraTotals ?? []) ws.addRow([t.label, Number(t.value)]).font = { bold: true };
  report.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1); col.width = c.type === 'money' ? 16 : c.type === 'date' ? 12 : c.type === 'text' ? Math.min(34, Math.max(12, c.label.length + 6)) : 13;
    if (c.type === 'money') col.numFmt = '#,##0.000'; if (c.type === 'qty') col.numFmt = '#,##0.####'; if (c.type === 'date') col.numFmt = 'dd/mm/yyyy'; if (c.type !== 'text' && c.type !== 'date') col.alignment = { horizontal: 'right' };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(report, meta) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true }); const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 60; const cols = report.columns;
    const weight = (c) => (c.type === 'money' ? 1.1 : c.type === 'date' ? 0.9 : c.type === 'number' || c.type === 'qty' ? 0.9 : 1.6); const tw = cols.reduce((s, c) => s + weight(c), 0); const widths = cols.map((c) => (weight(c) / tw) * W);
    const FS = cols.length > 9 ? 7 : 8;
    const header = () => { doc.font('Helvetica-Bold').fontSize(14).fillColor('#111').text(`${meta.company}`, 30, 30); doc.fontSize(12).text(report.title); doc.font('Helvetica').fontSize(9).fillColor('#444').text(meta.periodLabel); doc.moveDown(0.5); };
    const rowHeight = (vals) => Math.max(14, ...vals.map((v, i) => doc.heightOfString(String(v), { width: widths[i] - 6, lineBreak: true }) + 6));
    const drawRow = (vals, { bold = false, fill = null, color = '#111' } = {}) => {
      const h = rowHeight(vals); if (doc.y + h > doc.page.height - 50) { doc.addPage(); header(); drawHead(); }
      const y = doc.y; if (fill) doc.rect(30, y, W, h).fill(fill); doc.fillColor(color).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FS);
      let x = 30; vals.forEach((v, i) => { const right = ['money', 'qty', 'number'].includes(cols[i].type); doc.text(String(v), x + 3, y + 3, { width: widths[i] - 6, align: right ? 'right' : 'left' }); x += widths[i]; }); doc.y = y + h; doc.moveTo(30, doc.y).lineTo(30 + W, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
    };
    const drawHead = () => drawRow(cols.map((c) => c.label), { bold: true, fill: '#1e3a8a', color: '#fff' });
    header(); drawHead();
    report.rows.forEach((r, k) => drawRow(cols.map((c) => cell(r[c.key], c)), { fill: k % 2 ? '#f6f7fb' : null }));
    const tot = report.totals ?? {};
    if (Object.keys(tot).length) drawRow(cols.map((c, i) => (i === 0 ? 'TOTAL' : tot[c.key] !== undefined ? cell(tot[c.key], c) : '')), { bold: true, fill: '#e8ecf7' });
    for (const t of report.extraTotals ?? []) drawRow([t.label, ...Array(cols.length - 2).fill(''), frNum(t.value, 'money')].slice(0, cols.length), { bold: true });
    if (!report.rows.length) { doc.moveDown(); doc.font('Helvetica-Oblique').fontSize(10).fillColor('#666').text('Aucune donnée sur cette période.', 30); }
    const n = doc.bufferedPageRange().count;
    for (let i = 0; i < n; i++) { doc.switchToPage(i); doc.font('Helvetica').fontSize(7).fillColor('#777'); doc.text(`${DISCLAIMER}  —  Page ${i + 1}/${n}  —  Généré le ${meta.generatedAt}`, 30, doc.page.height - 30, { width: W, align: 'center', lineBreak: false }); }
    doc.end();
  });
}
