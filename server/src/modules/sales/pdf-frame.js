// En-tête et pied de page des documents PDF : plusieurs modèles au choix + un modèle personnalisé.
// Les choix sont enregistrés dans les réglages de l'entreprise (branding) et ne touchent jamais au contenu comptable du document.
// Chaque fonction reçoit un contexte `c` (pdfkit, peintre de texte, marges, réglages, identité) et ne fait que dessiner.

export const HEADER_STYLES = ['classic', 'centered', 'band', 'minimal', 'custom'];
export const FOOTER_STYLES = ['classic', 'columns', 'minimal', 'custom'];
export const ALIGNS = ['left', 'center', 'right'];
const ALIGN = { left: 'start', center: 'center', right: 'end' };
const PAGE_W = 595.28;

// Texte lisible sur la couleur d'accent (blanc sur couleur foncée, encre sur couleur claire).
export function onColor(hex) {
  const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62 ? '#111827' : '#ffffff';
}
const cleanLines = (s, max) => String(s ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, max);

function logoOf(c, maxW, maxH) {
  const { pdf, branding } = c;
  if (!branding.logo) return null;
  try {
    const img = pdf.openImage(Buffer.from(branding.logo.split(',')[1], 'base64'));
    const k = Math.min(maxW / img.width, maxH / img.height, 1.5);
    return { img, w: img.width * k, h: img.height * k };
  } catch { return null; /* logo illisible : ignoré */ }
}
const initialsOf = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'M';

// Dessine le logo (ou la pastille d'initiales) à x, y ; retourne sa taille.
function drawMark(c, x, y, { maxW = 110, maxH = 52, chip = null } = {}) {
  const { pdf, put, bx, accent, sellerName } = c;
  const lg = logoOf(c, maxW, maxH);
  if (lg) {
    if (chip) pdf.roundedRect(bx(x - 5, lg.w + 10), y - 5, lg.w + 10, lg.h + 10, 6).fill(chip);
    pdf.image(lg.img, bx(x, lg.w), y, { width: lg.w, height: lg.h });
    return { w: lg.w, h: lg.h, logo: true };
  }
  pdf.roundedRect(bx(x, 46), y, 46, 46, 9).fill(chip ?? accent);
  put(initialsOf(sellerName), x, y + 14, 46, { size: 16, bold: true, color: chip ? accent : onColor(accent), align: 'center' });
  return { w: 46, h: 46, logo: false };
}

// Variante « empilée » (centrée ou personnalisée) : logo, identité, filet, puis titre et numéro, tous alignés pareil.
function stacked(c, { align, lines, showMark }) {
  const { pdf, put, L, R, W, accent, GREY, INK, docTitle, numberText, sellerName } = c;
  const al = ALIGN[align] ?? 'center'; let y = 40;
  if (showMark) {
    const lg = logoOf(c, 130, 56); const w = lg ? lg.w : 46; const h = lg ? lg.h : 46;
    const x = align === 'left' ? L : align === 'right' ? R - w : L + (W - w) / 2;
    drawMark(c, x, y, { maxW: 130, maxH: 56 }); y += h + 10;
  }
  lines.forEach((l, i) => { y = put(l, L, y, W, { size: i === 0 ? 13 : 8.5, bold: i === 0, color: i === 0 ? INK : GREY, align: al }) + (i === 0 ? 2 : 0); });
  if (!lines.length) y = put(sellerName, L, y, W, { size: 13, bold: true, color: INK, align: al });
  y += 8; pdf.rect(L, y, W, 2.5).fill(accent); y += 14;
  y = put(docTitle, L, y, W, { size: 22, bold: true, color: accent, align: al });
  y = put(numberText, L, y + 1, W, { size: 11, bold: true, color: INK, align: al });
  return y + 14;
}

export function drawHeader(c) {
  const { pdf, put, bx, L, R, W, branding, accent, GREY, INK, docTitle, numberText, sellerName, sellerLines } = c;
  const style = HEADER_STYLES.includes(branding.headerStyle) ? branding.headerStyle : 'classic';
  const idLines = cleanLines(sellerLines, 6);

  if (style === 'centered') return stacked(c, { align: 'center', lines: [sellerName, ...idLines], showMark: true });

  if (style === 'custom') {
    const custom = cleanLines(branding.headerText, 5);
    return stacked(c, { align: ALIGNS.includes(branding.headerAlign) ? branding.headerAlign : 'left', lines: custom.length ? custom : [sellerName, ...idLines], showMark: branding.showLogo !== false });
  }

  if (style === 'band') {
    const ink = onColor(accent); const soft = ink === '#ffffff' ? '#e5e7eb' : '#374151';
    const bandH = 98; pdf.rect(0, 0, PAGE_W, bandH).fill(accent);
    const m = drawMark(c, L, 24, { maxW: 100, maxH: 48, chip: '#ffffff' });
    const sx = L + (m.logo ? m.w + 22 : m.w + 14); const sw = 330 - sx - 8;
    let ly = put(sellerName, sx, 22, sw, { size: 12.5, bold: true, color: ink });
    ly = put(sellerLines, sx, ly + 2, sw, { size: 8, color: soft });
    const ty = put(docTitle, 330, 22, R - 330, { size: 22, bold: true, color: ink, align: 'end' });
    put(numberText, 330, ty + 2, R - 330, { size: 11, bold: true, color: ink, align: 'end' });
    return Math.max(bandH, ly) + 20;
  }

  if (style === 'minimal') {
    // Titre et numéro à gauche, identité sobre à droite, simple filet gris.
    const ty = put(docTitle, L, 40, 270, { size: 22, bold: true, color: accent });
    const ny = put(numberText, L, ty + 1, 270, { size: 11, bold: true, color: INK });
    let ry = 40;
    const lg = logoOf(c, 120, 34);
    if (lg) { pdf.image(lg.img, bx(R - lg.w, lg.w), ry, { width: lg.w, height: lg.h }); ry += lg.h + 6; }
    ry = put(sellerName, 300, ry, R - 300, { size: 10.5, bold: true, color: INK, align: 'end' });
    ry = put(sellerLines, 300, ry + 1, R - 300, { size: 8, color: GREY, align: 'end' });
    const end = Math.max(ny, ry) + 12; pdf.moveTo(L, end).lineTo(R, end).strokeColor('#9ca3af').lineWidth(0.8).stroke();
    return end + 18;
  }

  // classic : logo + identité à gauche, titre et numéro à droite, filet de couleur
  const y = 40; const m = drawMark(c, L, y); const logoW = m.logo ? m.w + 14 : 60; const logoH = m.h;
  const sx = L + logoW; const sw = 330 - sx - 8;
  let ly = put(sellerName, sx, y, sw, { size: 12.5, bold: true, color: INK });
  ly = put(sellerLines, sx, ly + 2, sw, { size: 8.5, color: GREY });
  const ty = put(docTitle, 330, y - 2, R - 330, { size: 24, bold: true, color: accent, align: 'end' });
  const ny = put(numberText, 330, ty + 1, R - 330, { size: 11, bold: true, color: INK, align: 'end' });
  const headEnd = Math.max(ly, ny, y + logoH) + 10;
  pdf.rect(L, headEnd, W, 2.5).fill(accent);
  return headEnd + 18;
}

// Pied de page d'une page (i = index de page à partir de 0, count = nombre de pages).
export function drawFooter(c, i, count) {
  const { pdf, put, L, R, W, branding, GREY, seller, sellerName, T } = c;
  const style = FOOTER_STYLES.includes(branding.footerStyle) ? branding.footerStyle : 'classic';
  const pageTxt = `${T.page} ${i + 1}/${count}`;
  const rule = (y = 790) => pdf.moveTo(L, y).lineTo(R, y).strokeColor('#d1d5db').lineWidth(0.6).stroke();
  const fiscal = [seller.taxId && `${T.mf} ${seller.taxId}`, seller.tradeRegister && `${T.rc} ${seller.tradeRegister}`].filter(Boolean);
  const addr = [seller.address, [seller.postalCode, seller.governorate].filter(Boolean).join(' ')].filter(Boolean);

  if (style === 'minimal') { rule(); put(pageTxt, L, 796, W, { size: 7.5, color: '#9ca3af', align: 'end' }); return; }

  if (style === 'columns') {
    rule(); const cw = (W - 20) / 3; const top = 796;
    const col = (k, lines) => { let y = top; lines.forEach((l, j) => { y = put(l, L + k * (cw + 10), y, cw, { size: 7.5, bold: j === 0 && k === 0, color: GREY }); }); };
    col(0, [sellerName, ...addr]);
    col(1, [seller.phone && `${T.tel} : ${seller.phone}`, seller.email, seller.website].filter(Boolean));
    col(2, fiscal);
    put(pageTxt, L, 828, W, { size: 7.5, color: '#9ca3af', align: 'center' });
    return;
  }

  if (style === 'custom') {
    const al = ALIGN[branding.footerAlign] ?? 'center'; rule();
    let lines = cleanLines(branding.footerText, 4);
    if (!lines.length) lines = [[sellerName, ...fiscal, addr.join(', ')].filter(Boolean).join(' · ')];
    // 3 lignes affichées au plus (après retour à la ligne automatique) pour ne jamais sortir de la page
    const wrapped = lines.flatMap((l) => c.P.wrap(l, W, 7.5, false).map((t) => t.join(' '))).slice(0, 3);
    let y = 796; for (const l of wrapped) y = put(l, L, y, W, { size: 7.5, color: GREY, align: al });
    if (branding.showPageNumber !== false) put(pageTxt, L, y + 1, W, { size: 7.5, color: '#9ca3af', align: al });
    return;
  }

  // classic
  rule();
  const footerText = [sellerName, ...fiscal, [seller.address, seller.governorate].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const fy = put(footerText, L, 796, W, { size: 7.5, color: GREY, align: 'center' });
  put(pageTxt, L, fy + 1, W, { size: 7.5, color: '#9ca3af', align: 'center' });
}
