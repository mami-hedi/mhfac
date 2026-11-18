// Génération PDF (pdfkit), en français. Mise en page unique ; l'en-tête et le pied de page ont plusieurs modèles au choix (pdf-frame.js),
// avec couleur et logo de l'entreprise.
// Les caractères arabes saisis dans un nom (client, article) restent imprimables grâce à la police de repli Cairo.
// Les anciennes valeurs de modèle (classic, modern, minimal) restent acceptées pour compatibilité mais donnent toutes ce modèle.
// Les montants proviennent du serveur, jamais recalculés ici.
// Arabe : pdfkit/fontkit mettent les lettres en forme (liaisons) mais n'appliquent pas l'ordre bidirectionnel des mots ;
// le Painter ci-dessous découpe le texte en mots, classe chaque mot (arabe / latin-chiffres) et les place dans l'ordre visuel.
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { pool } from '../../config/db.js';
import { getSettings } from '../companies/settings.js';
import { amountInWords } from '../../core/words.js';
import { drawHeader, drawFooter } from './pdf-frame.js';

const FONT_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
export const TEMPLATES = ['classic', 'modern', 'minimal'];
export const LANGS = ['fr']; // documents uniquement en français

const I18N = {
  fr: {
    title: { quote: 'DEVIS', sales_order: 'BON DE COMMANDE', invoice: 'FACTURE', deposit: "FACTURE D'ACOMPTE", final: 'FACTURE DE SOLDE', credit_note: 'AVOIR', delivery_note: 'BON DE LIVRAISON', purchase_order: 'BON DE COMMANDE FOURNISSEUR' },
    draft: 'BROUILLON', date: 'Date', due: 'Échéance', validUntil: "Valable jusqu'au", origInvoice: "Facture d'origine", rate: 'Taux de change', order: 'Commande', deliveryDate: 'Date de livraison', deliveryAddress: 'Adresse de livraison',
    client: 'CLIENT', supplier: 'FOURNISSEUR', mf: 'MF', rc: 'RC', tel: 'Tél',
    cols: { description: 'Désignation', quantity: 'Qté', unitPrice: 'PU HT', discountPct: 'Rem.', taxRate: 'TVA', netAmount: 'Total HT', unit: 'Unité' },
    taxBase: 'Base de TVA par taux', taxHead: 'Taux · Base · TVA',
    totalHt: 'Total HT', globalDiscount: 'Remise globale', totalHtNet: 'Total HT net', totalTax: 'Total TVA', totalTtc: 'Total TTC', stamp: 'Timbre fiscal', withholding: 'Retenue à la source', deposit: 'Acompte', depositsDeducted: 'Acomptes déjà facturés',
    net: 'NET À PAYER', netCredit: 'NET À RESTITUER', reason: 'Motif', terms: 'Conditions de paiement', days: (n) => `${n} jours`, payInfo: 'Coordonnées de règlement', notes: 'Notes', cgv: 'Conditions générales', legal: 'Mentions légales', page: 'Page',
    watermark: { draft: 'BROUILLON', cancelled: 'ANNULÉE', refused: 'REFUSÉ', sample: 'EXEMPLE' },
    signature: 'Signature et cachet du client', received: 'Reçu en bon état',
    billedTo: 'Facturé à', condShort: 'Conditions', reference: 'Référence', vatRecap: 'Récapitulatif TVA', rateCol: 'Taux', baseCol: 'Base', vatCol: 'TVA',
    wordsIntro: { invoice: 'Arrêtée la présente facture à la somme de :', deposit: 'Arrêtée la présente facture à la somme de :', final: 'Arrêtée la présente facture à la somme de :', quote: 'Arrêté le présent devis à la somme de :', sales_order: 'Arrêtée la présente commande à la somme de :', credit_note: 'Arrêté le présent avoir à la somme de :', purchase_order: 'Arrêtée la présente commande à la somme de :' },
    approval: 'Bon pour accord', approvalSub: 'Date, signature et cachet du client', carrier: 'Le livreur', carrierSub: 'Nom, date et signature', receivedBy: 'Le client : reçu en bon état', receivedSub: 'Nom, date, signature et cachet',
  },
};

const AR = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const nf3 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtN = (v) => nf3.format(Number(v)).replace(/[  ]/g, ' ');
const fmt = (v, cur) => `${fmtN(v)} ${cur}`;
const dateFr = (iso) => (iso ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}/${String(iso).slice(0, 4)}` : '');

// ---- Peintre : texte multilingue, retours à la ligne, ordre visuel des mots arabes/latins
export class Painter {
  constructor(pdf, lang) { this.pdf = pdf; this.rtl = lang === 'ar'; this.arDoc = lang === 'ar'; }
  fontFor(token, bold, ar = false) {
    if (ar || AR.test(token) || this.arDoc) return bold ? 'Cairo-Bold' : 'Cairo';
    return bold ? 'Helvetica-Bold' : 'Helvetica';
  }
  w(token, size, bold, ar = false) { return this.pdf.font(this.fontFor(token, bold, ar)).fontSize(size).widthOfString(token); }
  lineH(size, ar = this.arDoc) { return size * (ar ? 1.5 : 1.28); }

  // Découpe en lignes de jetons (mots) selon la largeur.
  wrap(str, width, size, bold) {
    const lines = [];
    for (const para of String(str ?? '').split('\n')) {
      const tokens = para.split(/ +/).filter((t) => t !== '');
      let cur = []; let curW = 0;
      for (const t of tokens) {
        const tw = this.w(t, size, bold); const sp = this.w(' ', size, bold);
        if (cur.length && curW + sp + tw > width) { lines.push(cur); cur = [t]; curW = tw; } else { curW += (cur.length ? sp : 0) + tw; cur.push(t); }
      }
      lines.push(cur);
    }
    return lines;
  }
  height(str, width, size, bold) { return this.wrap(str, width, size, bold).reduce((a, l) => a + this.lineH(size, this.arDoc || AR.test(l.join(' '))), 0); }

  // Ordre visuel (gauche -> droite) des jetons d'une ligne.
  visual(tokens) {
    const runs = [];
    for (const t of tokens) { const k = AR.test(t) ? 'ar' : 'ltr'; if (runs.length && runs.at(-1).k === k) runs.at(-1).t.push(t); else runs.push({ k, t: [t] }); }
    // les mots d'un passage arabe se lisent de droite à gauche
    const seq = runs.map((r) => (r.k === 'ar' ? [...r.t].reverse() : r.t));
    return (this.rtl ? seq.reverse() : seq).flat();
  }

  // align : 'start' | 'end' | 'center' (start = droite en mode RTL). Retourne le y de fin.
  text(str, x, y, { width, size = 9, bold = false, color = '#111827', align = 'start' } = {}) {
    for (const line of this.wrap(str, width, size, bold)) {
      const lh = this.lineH(size, this.arDoc || AR.test(line.join(' ')));
      const lar = this.arDoc || AR.test(line.join(' ')); // ligne mixte : une seule police (même ligne de base)
      const vis = this.visual(line); const sp = this.w(' ', size, bold, lar);
      const widths = vis.map((t) => this.w(t, size, bold, lar));
      const total = widths.reduce((a, b) => a + b, 0) + sp * Math.max(0, vis.length - 1);
      const left = align === 'center' ? x + (width - total) / 2 : ((align === 'start') !== this.rtl ? x : x + width - total);
      let cx = left;
      vis.forEach((t, i) => {
        this.pdf.font(this.fontFor(t, bold, lar)).fontSize(size).fillColor(color).text(t, cx, y, { lineBreak: false });
        cx += widths[i] + sp;
      });
      y += lh;
    }
    return y;
  }
}

const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const HEX = /^#[0-9a-fA-F]{6}$/;

export async function renderDocumentPdf({ kind, doc, companyId, lang, accent: accentOverride, branding: brandingOverride, sample = false }) {
  const [[c]] = await pool.query('SELECT * FROM companies WHERE id = ?', [companyId]);
  const settings = await getSettings(companyId);
  const lg = 'fr'; // français uniquement (le paramètre `lang` éventuel est ignoré)
  const T = I18N[lg];
  const seller = doc.company ?? { name: c.name, legalName: c.legal_name, taxId: c.tax_id, ...settings.identity };
  const branding = { ...settings.branding, ...(brandingOverride ?? {}) }; // l'aperçu des réglages peut surcharger le modèle sans rien enregistrer
  const accent = HEX.test(accentOverride ?? '') ? accentOverride : HEX.test(branding.accentColor ?? '') ? branding.accentColor : '#1d4ed8';
  const cur = doc.currency ?? c.currency;
  const priced = kind !== 'delivery_note';
  const docTitle = kind === 'invoice' && doc.invoiceType && doc.invoiceType !== 'standard' ? T.title[doc.invoiceType] : T.title[kind];
  const sellerName = seller.legalName || seller.name || '';

  const pdf = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `${docTitle} ${doc.number ?? ''}`.trim(), Producer: 'MHFac' } });
  pdf.registerFont('Cairo', `${FONT_DIR}Cairo_400Regular.ttf`); pdf.registerFont('Cairo-Bold', `${FONT_DIR}Cairo_700Bold.ttf`);
  const chunks = []; pdf.on('data', (d) => chunks.push(d));
  const done = new Promise((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  const P = new Painter(pdf, lg); const rtl = P.rtl;
  const L = 40; const R = 555; const W = R - L; const BOTTOM = 745; // au-delà : saut de page (le pied fixe occupe le bas)
  const bx = (x, w) => (rtl ? L + R - x - w : x); // miroir horizontal d'une boîte pensée en LTR
  const put = (str, x, y, w, o = {}) => P.text(str, bx(x, w), y, { width: w, ...o });
  const GREY = '#6b7280'; const INK = '#111827'; const SOFT = '#374151';

  // ---- En-tête : modèle choisi dans les réglages (classique, centré, bandeau, sobre ou personnalisé) — voir pdf-frame.js
  const sellerLines = [[seller.address, [seller.postalCode, seller.governorate].filter(Boolean).join(' ')].filter(Boolean).join(', '), [seller.phone && `${T.tel} : ${seller.phone}`, seller.email].filter(Boolean).join(' · '), [seller.taxId && `${T.mf} : ${seller.taxId}`, seller.tradeRegister && `${T.rc} : ${seller.tradeRegister}`].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
  const frame = { pdf, P, put, bx, L, R, W, branding, accent, GREY, INK, docTitle, numberText: doc.number ? `N° ${doc.number}` : T.draft, seller, sellerName, sellerLines, T };
  let y = drawHeader(frame);

  // ---- Client (à gauche) et références du document (à droite)
  const cl = doc.client ?? {};
  const clientLines = [cl.address, [cl.postalCode, cl.governorate].filter(Boolean).join(' '), cl.taxId && `${T.mf} : ${cl.taxId}`, kind === 'delivery_note' && doc.deliveryAddress && `${T.deliveryAddress} : ${doc.deliveryAddress}`].filter(Boolean).join('\n');
  const pairs = [[T.date, dateFr(doc.issueDate ?? doc.deliveryDate)]];
  if (kind === 'quote' && doc.validUntil) pairs.push([T.validUntil, dateFr(doc.validUntil)]);
  if ((kind === 'sales_order' || kind === 'purchase_order') && doc.expectedDate) pairs.push([T.deliveryDate, dateFr(doc.expectedDate)]);
  if (kind === 'invoice') { pairs.push([T.due, dateFr(doc.dueDate)]); if (doc.paymentTermsDays) pairs.push([T.condShort, T.days(doc.paymentTermsDays)]); }
  if (kind === 'credit_note' && doc.creditedInvoice) pairs.push([T.origInvoice, doc.creditedInvoice.number]);
  if (kind === 'delivery_note' && doc.order) pairs.push([T.order, doc.order.number]);
  if (kind === 'delivery_note' && doc.vehiclePlate) pairs.push([T.vehicle ?? 'Véhicule', doc.vehiclePlate]);
  const ref = doc.quote?.number ?? doc.reference; if (kind === 'invoice' && ref) pairs.push([T.reference, ref]);
  if (priced && doc.currency && doc.currency !== c.currency) pairs.push([T.rate, `1 ${doc.currency} = ${Number(doc.exchangeRate)} ${c.currency}`]);
  const metaW = 205; const clientW = W - metaW - 14; const metaX = clientW + 14;
  const clientH = 26 + P.height(cl.name ?? '', clientW - 24, 11, true) + (clientLines ? P.height(clientLines, clientW - 24, 9) + 2 : 0) + 8;
  const boxH = Math.max(clientH, 16 + pairs.length * 15 + 6);
  pdf.roundedRect(bx(0 + L, clientW), y, clientW, boxH, 5).strokeColor('#d1d5db').lineWidth(0.8).stroke();
  pdf.roundedRect(bx(metaX + L, metaW), y, metaW, boxH, 5).strokeColor('#d1d5db').lineWidth(0.8).stroke();
  put(kind === 'purchase_order' ? T.supplier : kind === 'invoice' ? T.billedTo : T.client, L + 12, y + 9, clientW - 24, { size: 7.5, bold: true, color: GREY });
  const cy = put(cl.name ?? '', L + 12, y + 21, clientW - 24, { size: 11, bold: true, color: INK });
  if (clientLines) put(clientLines, L + 12, cy + 2, clientW - 24, { size: 9, color: SOFT });
  pairs.forEach(([k, v], i) => {
    put(k, L + metaX + 12, y + 10 + i * 15, 90, { size: 8.5, color: GREY });
    put(v, L + metaX + 100, y + 10 + i * 15, metaW - 112, { size: 8.5, bold: true, color: INK, align: 'end' });
  });
  y += boxH + 20;

  // ---- Table des lignes (colonnes pensées en LTR puis miroir)
  const cols = priced
    ? [{ k: 'description', x: L, w: 215, a: 'start' }, { k: 'quantity', x: 255, w: 40, a: 'end' }, { k: 'unitPrice', x: 297, w: 62, a: 'end' }, { k: 'discountPct', x: 361, w: 34, a: 'end' }, { k: 'taxRate', x: 397, w: 34, a: 'end' }, { k: 'netAmount', x: 433, w: R - 433, a: 'end' }]
    : [{ k: 'description', x: L, w: 355, a: 'start' }, { k: 'quantity', x: 397, w: 80, a: 'end' }, { k: 'unit', x: 479, w: R - 479, a: 'end' }];
  const rowText = (l, k) => ({ description: l.description, quantity: kind === 'delivery_note' ? String(Number(l.quantity)) : `${Number(l.quantity)} ${l.unit && l.unit !== 'unité' ? l.unit : ''}`.trim(), unit: l.unit ?? '', unitPrice: fmtN(l.unitPrice), discountPct: Number(l.discountPct) ? `${Number(l.discountPct)} %` : '', taxRate: `${Number(l.taxRate)} %`, netAmount: fmtN(l.netAmount) }[k]);
  const drawHead = (yy) => {
    pdf.rect(L, yy, W, 22).fill('#f1f5f9'); pdf.rect(L, yy + 21, W, 1.5).fill(accent);
    cols.forEach((col) => put(T.cols[col.k], col.x + 3, yy + 6, col.w - 6, { size: 8.5, bold: true, color: INK, align: col.a }));
    return yy + 27;
  };
  y = drawHead(y);
  for (const l of doc.lines) {
    const h = Math.max(20, P.height(l.description, cols[0].w - 6, 8.5) + 10);
    if (y + h > BOTTOM) { pdf.addPage(); y = drawHead(40); }
    cols.forEach((col) => put(rowText(l, col.k), col.x + 3, y + 3, col.w - 6, { size: 8.5, bold: col.k === 'netAmount', color: INK, align: col.a }));
    y += h; pdf.moveTo(L, y - 2).lineTo(R, y - 2).strokeColor('#e5e7eb').lineWidth(0.6).stroke();
  }

  if (priced) {
    // ---- Récapitulatif TVA (gauche) + totaux (droite)
    const rows = [[T.totalHt, fmt(doc.subtotal, cur)]];
    if (Number(doc.globalDiscountAmount) > 0) { rows.push([`${T.globalDiscount} (${Number(doc.globalDiscountPct)} %)`, `- ${fmt(doc.globalDiscountAmount, cur)}`]); rows.push([T.totalHtNet, fmt(doc.totalHt, cur)]); }
    if (Number(doc.fodecAmount) > 0) rows.push([`FODEC (${Number(doc.fodecRate)} %)`, fmt(doc.fodecAmount, cur)]);
    rows.push([T.totalTax, fmt(doc.totalTax, cur)], [T.totalTtc, fmt(doc.totalTtc, cur)]);
    if (Number(doc.stampDuty) > 0) rows.push([T.stamp, fmt(doc.stampDuty, cur)]);
    if (Number(doc.withholdingAmount) > 0) rows.push([`${T.withholding} (${Number(doc.withholdingRate)} %)`, `- ${fmt(doc.withholdingAmount, cur)}`]);
    for (const d of doc.deposits ?? []) rows.push([`${T.deposit} ${d.number}`, `- ${fmt(d.amount, cur)}`]);
    const rowH = P.lineH(9) + 3; const totalsH = rows.length * rowH + 40;
    if (y + totalsH + 90 > BOTTOM) { pdf.addPage(); y = 40; }
    y += 14; const top = y;
    let ty2 = put(T.vatRecap, L, y, 240, { size: 7.5, bold: true, color: GREY }) + 4;
    const vc = [{ x: L, w: 50, a: 'start', k: T.rateCol }, { x: L + 55, w: 90, a: 'end', k: T.baseCol }, { x: L + 150, w: 90, a: 'end', k: T.vatCol }];
    vc.forEach((q) => put(q.k, q.x, ty2, q.w, { size: 8, bold: true, color: SOFT, align: q.a }));
    ty2 += 13; pdf.moveTo(L, ty2 - 2).lineTo(L + 240, ty2 - 2).strokeColor('#d1d5db').lineWidth(0.6).stroke();
    for (const t of doc.taxes ?? []) {
      put(`${Number(t.taxRate)} %`, vc[0].x, ty2, vc[0].w, { size: 8.5 }); put(fmtN(t.base), vc[1].x, ty2, vc[1].w, { size: 8.5, align: 'end' }); put(fmtN(t.amount), vc[2].x, ty2, vc[2].w, { size: 8.5, align: 'end' }); ty2 += 14;
    }
    let ry = top;
    for (const [a, b] of rows) { put(a, 320, ry, 130, { size: 9, color: SOFT }); put(b, 440, ry, R - 440, { size: 9, color: INK, align: 'end' }); ry += rowH; }
    pdf.roundedRect(bx(310, R - 310), ry + 4, R - 310, 28, 4).fill(accent);
    put(kind === 'credit_note' ? T.netCredit : T.net, 320, ry + 12, 115, { size: 10, bold: true, color: '#ffffff' });
    put(fmt(doc.netPayable, cur), 426, ry + 12, R - 436, { size: 10.5, bold: true, color: '#ffffff', align: 'end' });
    y = Math.max(ry + 32, ty2) + 16;

    // ---- Montant en lettres (uniquement si le montant se met en lettres sans l'altérer)
    const words = amountInWords(doc.netPayable, cur, lg);
    if (words) {
      const body = lg === 'fr' ? `${cap(words)}.` : `${words}.`; const intro = T.wordsIntro[kind] ?? T.wordsIntro.invoice;
      const h = P.lineH(8.5) + P.height(body, W - 28, 9, true) + 14;
      if (y + h > BOTTOM) { pdf.addPage(); y = 40; }
      pdf.rect(L, y, W, h).fill('#f8fafc'); pdf.rect(bx(L, 3), y, 3, h).fill(accent);
      const wy = put(intro, L + 14, y + 6, W - 28, { size: 8.5, color: GREY });
      put(body, L + 14, wy, W - 28, { size: 9, bold: true, color: INK });
      y += h + 14;
    }
  } else {
    y += 10;
  }

  // ---- Règlement, conditions, mentions
  const blocks = [];
  if (kind === 'credit_note' && doc.creditReason) blocks.push([T.reason, doc.creditReason]);
  if (priced && settings.sales.paymentInfo) blocks.push([T.payInfo, settings.sales.paymentInfo]);
  if (doc.notes) blocks.push([T.notes, doc.notes]);
  if (priced && doc.terms) blocks.push([T.cgv, doc.terms]);
  if (priced && settings.sales.legalMentions) blocks.push([T.legal, settings.sales.legalMentions]);
  for (const [t, body] of blocks) {
    const need = P.lineH(8) + P.height(body, W, 8.5);
    if (y + need > BOTTOM) { pdf.addPage(); y = 40; }
    y = put(lg === 'fr' ? t.toUpperCase() : t, L, y, W, { size: 7.5, bold: true, color: GREY }) + 1;
    y = put(body, L, y, W, { size: 8.5, color: SOFT }) + 9;
  }

  // ---- Zones de signature : « Bon pour accord » (devis) ; livreur et client « reçu en bon état » (bon de livraison)
  const signBox = (x, w, title, sub) => {
    pdf.roundedRect(bx(x, w), y, w, 78, 5).strokeColor('#9ca3af').lineWidth(0.8).stroke();
    put(title, x + 10, y + 8, w - 20, { size: 9, bold: true, color: INK }); put(sub, x + 10, y + 21, w - 20, { size: 7.5, color: GREY });
  };
  if (kind === 'quote' || kind === 'delivery_note') {
    if (y + 90 > BOTTOM + 20) { pdf.addPage(); y = 40; }
    y += 4;
    if (kind === 'quote') signBox(R - 240, 240, T.approval, T.approvalSub);
    else { signBox(L, 245, T.carrier, T.carrierSub); signBox(R - 245, 245, T.receivedBy, T.receivedSub); }
    y += 86;
  }

  // ---- Pied de page fixe, filigrane d'état et pagination (sur toutes les pages)
  const markKey = sample ? 'sample' : doc.status === 'draft' ? 'draft' : doc.status === 'cancelled' ? 'cancelled' : doc.status === 'refused' ? 'refused' : null;
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    pdf.switchToPage(i);
    if (markKey) {
      pdf.save(); pdf.rotate(-35, { origin: [297, 420] }); pdf.opacity(0.1);
      const mw = pdf.font(lg === 'ar' ? 'Cairo-Bold' : 'Helvetica-Bold').fontSize(90).widthOfString(T.watermark[markKey]);
      pdf.fillColor('#dc2626').text(T.watermark[markKey], 297 - mw / 2, 370, { lineBreak: false }); pdf.restore();
    }
    pdf.page.margins.bottom = 0;
    drawFooter(frame, i - range.start, range.count); // pied de page : modèle choisi dans les réglages
  }
  pdf.end();
  return done;
}
