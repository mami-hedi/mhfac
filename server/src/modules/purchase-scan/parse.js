// Analyse du TEXTE d'une facture fournisseur (issu du PDF ou de l'OCR) par règles : retrouve fournisseur, n°, dates, lignes, totaux.
// C'est une aide à la saisie : le résultat est toujours relu par l'utilisateur et revalidé par normalize().
const AMT = String.raw`-?\d{1,3}(?:[ . ]\d{3})+(?:[.,]\d{1,3})?|-?\d+(?:[.,]\d{1,3})?`;
const AMT_RE = new RegExp(`(?<![\\w/])(${AMT})(?![\\w/])`, 'g');

export function toNumber(s) {
  let t = String(s).replace(/[\s ]/g, '');
  const dots = (t.match(/\./g) ?? []).length; const commas = (t.match(/,/g) ?? []).length;
  if (dots && commas) { const dec = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.'; t = t.split(dec === ',' ? '.' : ',').join('').replace(dec, '.'); }
  else if (commas > 1 || dots > 1) t = t.replace(/[.,]/g, '');
  else t = t.replace(',', '.');
  const n = Number(t); return Number.isFinite(n) ? n : null;
}
const amountsIn = (line) => [...line.matchAll(AMT_RE)].map((m) => toNumber(m[1])).filter((n) => n != null);
const lastAmount = (line) => { const a = amountsIn(line.replace(/\d+(?:[.,]\d+)?\s*%/g, ' ')); return a.length ? a[a.length - 1] : null; };

function parseDate(s) {
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); let y; let mo; let d;
  if (m) [, y, mo, d] = m; else { m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/); if (!m) return null; [, d, mo, y] = m; if (y.length === 2) y = `20${y}`; }
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; const dt = new Date(`${iso}T00:00:00Z`);
  return Number(y) >= 1990 && Number(y) <= 2100 && dt.getUTCMonth() + 1 === Number(mo) && dt.getUTCDate() === Number(d) ? iso : null;
}
const DATE_RE = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/;

const NOT_NAME = /facture|devis|avoir|bon\s+de|^date|page|t[ée]l|fax|\bmf\b|matricule|^rue|avenue|\bbd\b|boulevard|adresse|email|e-mail|www\.|r\.?c\.?|original|duplicata|client/i;

export function parseInvoiceText(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean);
  const all = lines.join('\n'); const hints = [];

  const head = lines.slice(0, 40).join(' ');
  const isCredit = /\bavoir\b/i.test(head) && !/\bfacture\s+(?:n|d)/i.test(head.replace(/facture d'avoir/i, ''));
  const documentType = isCredit ? 'credit_note' : /facture|invoice/i.test(all) ? 'invoice' : 'unknown';

  // n° du document
  let documentNumber = null;
  for (const l of lines.slice(0, 60)) {
    const m = l.match(/(?:facture|invoice|fact\.?|avoir)\s*(?:n[°ºo]\.?|num[ée]ro|#|:)?\s*:?\s*([A-Z0-9][A-Z0-9\-/_.]{1,30})/i);
    if (m && /\d/.test(m[1]) && !/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(m[1])) { documentNumber = m[1].replace(/[.,;]$/, ''); break; }
  }
  documentNumber ??= all.match(/\bn[°ºo]\s*:?\s*([A-Z0-9][A-Z0-9\-/_.]{2,30})/i)?.[1] ?? null;

  // dates
  let issueDate = null; let dueDate = null;
  for (const l of lines) {
    const d = DATE_RE.test(l) ? parseDate(l.match(DATE_RE)[0]) : null; if (!d) continue;
    if (/[ée]ch[ée]ance|due|r[èe]glement avant|payable/i.test(l)) { dueDate ??= parseDate(l.slice(l.search(/[ée]ch[ée]ance|due|r[èe]glement avant|payable/i)).match(DATE_RE)?.[0] ?? '') ?? d; }
    if (/\bdate\b|[ée]mis|le\s/i.test(l) && !issueDate) { const first = parseDate(l.match(DATE_RE)[0]); if (first && !/^\s*[ée]ch/i.test(l)) issueDate = first; }
  }
  if (!issueDate) { const any = lines.map((l) => (DATE_RE.test(l) ? parseDate(l.match(DATE_RE)[0]) : null)).find(Boolean); if (any) { issueDate = any; hints.push('Date de facture déduite : à vérifier'); } }
  if (dueDate && issueDate && dueDate < issueDate) dueDate = null;

  // fournisseur
  const mf = all.match(/(?:\bM\.?F\.?|matricule(?:\s+fiscal[e]?)?|\bTVA\s*n[°o]?)\s*:?\s*(\d{6,8})\s*[/\- ]?\s*([A-Z])\b/i);
  const taxId = mf ? `${mf[1]}/${mf[2].toUpperCase()}` : null;
  const email = all.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? null;
  const phone = all.match(/(?:t[ée]l\.?|phone|gsm|mob\.?)\s*:?\s*((?:\+?216)?[\d .-]{8,16})/i)?.[1]?.trim() ?? null;
  const name = lines.slice(0, 12).find((l) => l.length >= 3 && /[A-Za-zÀ-ÿ]{3}/.test(l) && !NOT_NAME.test(l) && !DATE_RE.test(l) && amountsIn(l).length === 0) ?? null;
  const address = lines.slice(0, 12).find((l) => /\b(rue|avenue|av\.|bd|boulevard|route|zone|cité|immeuble|résidence)\b/i.test(l) && l !== name) ?? null;

  // totaux
  const totals = {}; let rateFromFooter = null; const footerStart = lines.findIndex((l) => /^(?:sous[- ])?total\b|montant\s*(?:total\s*)?h\.?t|net\s*h\.?t|base\s*h\.?t/i.test(l));
  lines.forEach((l, i) => {
    if (/total\s*t\.?t\.?c|net\s*[àa]\s*payer|montant\s*t\.?t\.?c|total\s*g[ée]n[ée]ral|total\s*[àa]\s*payer/i.test(l)) { const v = lastAmount(l); if (v != null) totals.totalInclTax = v; }
    else if (/(?:total|montant|net|base)\s*(?:h\.?t|hors\s*tva|hors\s*taxe)/i.test(l)) { const v = lastAmount(l); if (v != null && totals.totalExclTax == null) totals.totalExclTax = v; }
    else if (/timbre/i.test(l)) { const v = lastAmount(l); if (v != null) totals.stampDuty = v; }
    else if (/retenue\s*(?:[àa]\s*la\s*source)?|\bR\.?S\.?\b\s*\d/i.test(l) && i > footerStart - 1) { const v = lastAmount(l); if (v != null) totals.withholdingAmount = v; }
    else if (/^(?:total\s*)?t\.?v\.?a\b/i.test(l)) { const v = lastAmount(l); const r = l.match(/(\d{1,2}(?:[.,]\d+)?)\s*%/); if (v != null) totals.totalTax = (totals.totalTax ?? 0) + v; if (r) rateFromFooter = rateFromFooter == null || rateFromFooter === toNumber(r[1]) ? toNumber(r[1]) : 'multi'; }
  });
  if (totals.totalTax != null) totals.totalTax = Math.round(totals.totalTax * 1000) / 1000;

  // lignes : entre l'en-tête du tableau et les totaux
  const hdr = lines.findIndex((l) => /d[ée]signation|description|libell[ée]|article|produit/i.test(l) && /(qt[ée]|quantit|prix|p\.?u|montant|total)/i.test(l));
  const end = lines.findIndex((l, i) => i > hdr && /^(?:sous[- ])?total|montant\s*(?:total\s*)?h\.?t|net\s*h\.?t|base\s*h\.?t|total\s*h/i.test(l));
  let body = hdr >= 0 ? lines.slice(hdr + 1, end > hdr ? end : undefined) : [];
  if (hdr < 0) { // en-tête du tableau non reconnu : on prend les lignes « texte + au moins 2 montants » situées avant les totaux
    const firstDate = lines.findIndex((l) => DATE_RE.test(l)); const stop = footerStart >= 0 ? footerStart : lines.length;
    body = lines.slice(firstDate + 1, stop).filter((l) => amountsIn(l).length >= 2 && !/:/.test(l) && !NOT_NAME.test(l));
    if (body.length) hints.push('En-tête du tableau non reconnu : vérifiez les lignes');
  }
  // « 1 850,000 » peut être un montant à espaces de milliers OU deux nombres (quantité 1, prix 850,000) :
  // on essaie les deux lectures et on garde celle dont quantité × prix = total sur le plus de lignes.
  const parseLine = (raw, merge) => {
    const l = merge ? raw.replace(/(?<=\d) (?=\d{3}(?:[.,]\d{1,3})?(?!\d))/g, '') : raw;
    const toks = l.split(' '); const nums = []; let tax = null;
    while (toks.length > 1) {
      const t = toks[toks.length - 1];
      if (/^\d{1,2}(?:[.,]\d+)?%$/.test(t)) { tax = toNumber(t.replace('%', '')); toks.pop(); }
      else if (new RegExp(`^(${AMT})$`).test(t)) { nums.unshift(toNumber(t)); toks.pop(); }
      else break;
    }
    const desc = toks.join(' ').replace(/[|_]+/g, ' ').trim();
    if (!desc || nums.length === 0 || !/[A-Za-zÀ-ÿ]{2}/.test(desc)) return null;
    let qty = null; let unit = null; const tot = nums[nums.length - 1];
    if (nums.length >= 3) { [qty, unit] = nums; if (Math.abs(qty * unit - tot) > Math.max(0.011, tot * 0.2)) unit = nums[1]; }
    else if (nums.length === 2) { unit = nums[0]; const q = unit ? tot / unit : null; qty = q && Number.isFinite(q) && Math.abs(q * 2 - Math.round(q * 2)) < 1e-6 && q > 0 ? q : null; }
    else { unit = tot; qty = 1; }
    const ok = nums.length >= 2 && qty != null && unit != null && Math.abs(qty * unit - tot) <= Math.max(0.011, tot * 0.005);
    return { item: { description: desc, quantity: qty, unitPriceExclTax: unit, taxRatePct: tax }, ok };
  };
  // « 1 850,000 » = un montant à espace de milliers OU deux nombres (qté 1, prix 850,000) : par ligne, on garde la lecture où quantité × prix = total.
  const items = [];
  for (const raw of body) { const m = parseLine(raw, true); const n = parseLine(raw, false); const pick = m?.ok ? m : n?.ok ? n : (m ?? n); if (pick) items.push(pick.item); }
  const rate = typeof rateFromFooter === 'number' ? rateFromFooter : null;
  for (const it of items) { if (it.taxRatePct == null && rate != null) it.taxRatePct = rate; }
  if (items.some((i) => i.taxRatePct != null) && rate != null && items.length) hints.push('Taux de TVA des lignes à vérifier');
  else if (rate != null && items.length) hints.push('Taux de TVA déduit du pied de facture : à vérifier');
  if (!items.length) hints.push('Les lignes n\'ont pas pu être lues : saisissez-les à partir du document');
  if (rateFromFooter === 'multi') hints.push('Plusieurs taux de TVA : choisissez le taux de chaque ligne');
  return { documentType, supplier: { name, taxId, address, email, phone }, documentNumber, issueDate, dueDate, currency: /\b(?:EUR|€)\b/.test(all) ? 'EUR' : /\b(?:USD|\$)\b/.test(all) ? 'USD' : 'TND', lines: items, totals, notes: null, warnings: hints };
}
