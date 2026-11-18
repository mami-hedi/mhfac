// PDF des bons de mouvement de stock : bon d'entrée, de prélèvement (sortie) et de transfert.
// Document de manutention : quantités, entrepôts, motif et zones de signature. Aucun prix de vente ; le coût unitaire
// n'apparaît que s'il a été saisi sur un bon d'entrée. Brouillon et bon annulé portent un filigrane.
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { pool } from '../../config/db.js';
import { getSettings } from '../companies/settings.js';
import { Painter } from '../sales/pdf.js';
import { drawHeader, drawFooter } from '../sales/pdf-frame.js';

const FONT_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
const AR = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const TITLES = { entry: "BON D'ENTRÉE", withdrawal: 'BON DE PRÉLÈVEMENT', transfer: 'BON DE TRANSFERT' };
const SIGNS = {
  entry: ['Établi par', 'Réceptionné par (magasinier)', 'Visa du responsable'],
  withdrawal: ['Établi par', 'Retiré par', 'Visa du responsable'],
  transfer: ['Établi par', 'Expédié par (origine)', 'Reçu par (destination)'],
};
const STATUS = { draft: 'BROUILLON', cancelled: 'ANNULÉ' };
const qtyFmt = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const money = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const dateFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

export async function renderStockVoucherPdf({ doc, companyId }) {
  const [[c]] = await pool.query('SELECT * FROM companies WHERE id = ?', [companyId]);
  const settings = await getSettings(companyId);
  const seller = { name: c.name, legalName: c.legal_name, taxId: c.tax_id, ...settings.identity };
  const accent = HEX.test(settings.branding.accentColor ?? '') ? settings.branding.accentColor : '#1d4ed8';
  const title = TITLES[doc.type] ?? 'BON DE STOCK';
  const showCost = doc.type === 'entry' && doc.lines.some((l) => l.unitCost != null && l.unitCost !== '');

  const pdf = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `${title} ${doc.number ?? ''}`.trim(), Producer: 'MHFac' } });
  pdf.registerFont('Cairo', `${FONT_DIR}Cairo_400Regular.ttf`); pdf.registerFont('Cairo-Bold', `${FONT_DIR}Cairo_700Bold.ttf`);
  const chunks = []; pdf.on('data', (d) => chunks.push(d));
  const done = new Promise((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  const L = 40; const R = 555; const W = R - L; const BOTTOM = 740;
  const GREY = '#6b7280'; const INK = '#111827';
  const fontFor = (t, bold) => (AR.test(String(t)) ? (bold ? 'Cairo-Bold' : 'Cairo') : (bold ? 'Helvetica-Bold' : 'Helvetica'));
  const text = (t, x, y, o = {}) => { const s = String(t ?? ''); pdf.font(fontFor(s, o.bold)).fontSize(o.size ?? 9).fillColor(o.color ?? INK).text(s, x, y, { width: o.width, align: o.align, lineBreak: o.lineBreak ?? true }); };
  const hOf = (t, w, size, bold) => { const s = String(t ?? ''); pdf.font(fontFor(s, bold)).fontSize(size); return pdf.heightOfString(s, { width: w }); };

  // En-tête : même choix de modèles que les documents commerciaux (pdf-frame.js), réglés dans Paramètres
  const sellerName = seller.legalName || seller.name || '';
  const P = new Painter(pdf, 'fr'); const bx = (x) => x;
  const put = (str, x, y, w, o = {}) => P.text(str, x, y, { width: w, ...o });
  const sellerLines = [[seller.address, [seller.postalCode, seller.governorate].filter(Boolean).join(' ')].filter(Boolean).join(', '), [seller.phone && `Tél : ${seller.phone}`, seller.email].filter(Boolean).join(' · '), seller.taxId && `MF : ${seller.taxId}`].filter(Boolean).join('\n');
  const branding = { ...settings.branding, accentColor: accent };
  const frame = { pdf, P, put, bx, L, R, W, branding, accent, GREY, INK, docTitle: title, numberText: doc.number ? `N° ${doc.number}` : 'Brouillon (sans numéro)', seller, sellerName, sellerLines, T: { page: 'Page', mf: 'MF', rc: 'RC', tel: 'Tél' } };
  let y = drawHeader(frame);

  // Bloc d'informations
  const info = doc.type === 'transfer'
    ? [['Date', dateFr(doc.date)], ['Origine', doc.warehouse?.name], ['Destination', doc.toWarehouse?.name], ['Véhicule', doc.vehiclePlate], ['Motif', doc.reason]]
    : [['Date', dateFr(doc.date)], ['Entrepôt', doc.warehouse?.name], ['Motif', doc.reason]];
  const colW = W / info.length;
  info.forEach(([k, v], i) => { text(k.toUpperCase(), L + i * colW, y, { size: 7.5, bold: true, color: GREY, width: colW - 8 }); text(v || '—', L + i * colW, y + 11, { size: 10, bold: true, width: colW - 8 }); });
  y += 40;

  // Tableau des lignes
  const cols = showCost
    ? [{ k: 'n', t: 'N°', x: L, w: 28 }, { k: 'd', t: 'Désignation', x: L + 28, w: 255 }, { k: 'u', t: 'Unité', x: L + 283, w: 50 }, { k: 'q', t: 'Quantité', x: L + 333, w: 70, r: true }, { k: 'c', t: 'Coût unitaire', x: L + 403, w: 112, r: true }]
    : [{ k: 'n', t: 'N°', x: L, w: 28 }, { k: 'd', t: 'Désignation', x: L + 28, w: 337 }, { k: 'u', t: 'Unité', x: L + 365, w: 60 }, { k: 'q', t: 'Quantité', x: L + 425, w: 90, r: true }];
  const head = () => {
    pdf.rect(L, y, W, 20).fill('#f3f4f6');
    for (const c2 of cols) text(c2.t.toUpperCase(), c2.x + 4, y + 6, { size: 7.5, bold: true, color: GREY, width: c2.w - 8, align: c2.r ? 'right' : 'left' });
    y += 24;
  };
  head();
  doc.lines.forEach((l, i) => {
    const name = l.sku ? `${l.name}  (${l.sku})` : l.name;
    const h = Math.max(hOf(name, cols[1].w - 8, 9, false), 12) + 8;
    if (y + h > BOTTOM - 120) { pdf.addPage(); y = 40; head(); }
    const row = { n: String(i + 1), d: name, u: l.unit ?? '', q: qtyFmt.format(Number(l.quantity)), c: l.unitCost != null && l.unitCost !== '' ? `${money.format(Number(l.unitCost))} TND` : '—' };
    for (const c2 of cols) text(row[c2.k], c2.x + 4, y + 4, { size: 9, width: c2.w - 8, align: c2.r ? 'right' : 'left', bold: c2.k === 'q' });
    y += h; pdf.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
  });
  y += 8; text(`${doc.lines.length} ligne${doc.lines.length > 1 ? 's' : ''}`, L, y, { size: 8.5, color: GREY, width: W, align: 'right' }); y += 18;
  if (doc.notes) {
    const nh = hOf(doc.notes, W, 9, false);
    if (y + nh + 20 > BOTTOM - 100) { pdf.addPage(); y = 40; }
    text('NOTES', L, y, { size: 7.5, bold: true, color: GREY, width: W }); text(doc.notes, L, y + 11, { size: 9, color: '#374151', width: W }); y += nh + 26;
  }
  if (doc.status === 'cancelled' && doc.cancelReason) { text(`Bon annulé — motif : ${doc.cancelReason}`, L, y, { size: 9, bold: true, color: '#b91c1c', width: W }); y += 20; }

  // Signatures (en bas de la dernière page)
  if (y > BOTTOM - 95) { pdf.addPage(); y = 40; }
  const sy = Math.max(y + 10, BOTTOM - 90); const sw = (W - 20) / 3;
  SIGNS[doc.type].forEach((label, i) => {
    const x = L + i * (sw + 10);
    pdf.roundedRect(x, sy, sw, 70, 4).lineWidth(0.7).strokeColor('#d1d5db').stroke();
    text(label, x + 8, sy + 7, { size: 8, bold: true, color: GREY, width: sw - 16 }); text('Nom, date, signature', x + 8, sy + 56, { size: 7, color: '#9ca3af', width: sw - 16 });
  });

  // Filigrane, numérotation et pied de page sur chaque page
  const range = pdf.bufferedPageRange();
  for (let p = 0; p < range.count; p++) {
    pdf.switchToPage(range.start + p);
    if (STATUS[doc.status]) {
      pdf.save(); pdf.rotate(-35, { origin: [297, 420] }); pdf.font('Helvetica-Bold').fontSize(64).fillColor('#9ca3af').fillOpacity(0.15);
      pdf.text(STATUS[doc.status], 60, 395, { width: 480, align: 'center', lineBreak: false }); pdf.restore(); pdf.fillOpacity(1);
    }
    drawFooter(frame, p, range.count);
  }
  pdf.end();
  return done;
}
