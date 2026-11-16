// Moteur de calcul des documents de vente — SEUL point de calcul financier (jamais dans le client).
// Arithmétique entière (BigInt) en millimes : aucun flottant binaire n'intervient.
//
// Règles (documentées, à valider avec un comptable) :
//  1. Net de ligne   = quantité × prix unitaire × (1 − remise ligne %), arrondi au millime (demi supérieur).
//  2. Remise globale = pourcentage appliqué à la base de CHAQUE taux : base = arrondi(Σ nets du taux × (1 − remise globale %)).
//  3. TVA            = arrondi(base × taux %) PAR TAUX (base imposable), pas ligne par ligne.
//  4. Total HT = Σ bases ; Total TVA = Σ TVA ; Total TTC = HT + TVA.
//  5. Timbre fiscal  = montant fixe ajouté après TTC (hors base de TVA et de retenue).
//  6. Retenue à la source = arrondi(TTC × taux %), déduite du net à payer.
//  7. Net à payer = TTC + timbre − retenue.
// Arrondi : « demi supérieur » au millime (3 décimales), sur valeurs positives (un avoir porte des montants positifs).

const S3 = 1000n;

const pow10 = (n) => 10n ** BigInt(n);

// Chaîne décimale -> entier mis à l'échelle (scale décimales). Refuse toute précision excédentaire.
export function toScaled(value, scale) {
  const raw = String(value ?? '0').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`Montant invalide : ${value}`);
  const [i, f = ''] = raw.split('.');
  if (f.length > scale && /[1-9]/.test(f.slice(scale))) throw new Error(`Trop de décimales : ${value}`);
  return BigInt(i + f.padEnd(scale, '0').slice(0, scale));
}

export function fromScaled(n, scale) {
  const neg = n < 0n; const abs = neg ? -n : n;
  const s = abs.toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
}

// n / d arrondi au plus proche, demi supérieur (n >= 0, d > 0)
const divRound = (n, d) => (n + d / 2n) / d;

export const money = (n) => fromScaled(n, 3);

/**
 * @param {object} input
 * @param {{quantity:string|number, unitPrice:string|number, discountPct?:string|number, taxRate:string|number}[]} input.lines
 * @param {string|number} [input.globalDiscountPct]
 * @param {string|number} [input.stampDuty]       montant (même devise que le document)
 * @param {string|number} [input.withholdingPct]
 */
export function computeDocument({ lines, globalDiscountPct = 0, stampDuty = 0, withholdingPct = 0, fodecRate = 0 }) {
  const fRate = toScaled(fodecRate, 2);
  if (fRate > 10000n) throw new Error('Taux FODEC > 100 %');
  const gPct = toScaled(globalDiscountPct, 2);
  if (gPct > 10000n) throw new Error('Remise globale > 100 %');
  const wPct = toScaled(withholdingPct, 2);
  if (wPct > 10000n) throw new Error('Retenue > 100 %');

  const byRate = new Map(); // taux de TVA (échelle 2) -> { sum: somme des nets de lignes, fodecSum: part soumise au FODEC } (millimes)
  let grossTotal = 0n;      // Σ quantité × prix avant toute remise

  const outLines = lines.map((l) => {
    const qty = toScaled(l.quantity, 4);
    const price = toScaled(l.unitPrice, 3);
    const dPct = toScaled(l.discountPct ?? 0, 2);
    const rate = toScaled(l.taxRate, 2);
    if (dPct > 10000n) throw new Error('Remise de ligne > 100 %');
    // qty(4) × price(3) = échelle 7 -> millimes
    const gross = divRound(qty * price, 10n ** 4n);
    const net = divRound(qty * price * (10000n - dPct), pow10(4 + 4)); // (échelle 7+4=11) -> 3 : /10^8
    grossTotal += gross;
    const acc = byRate.get(rate) ?? { sum: 0n, fodecSum: 0n };
    acc.sum += net; if (l.fodec && fRate > 0n) acc.fodecSum += net;
    byRate.set(rate, acc);
    return { grossAmount: money(gross), discountAmount: money(gross - net), netAmount: money(net), taxRate: fromScaled(rate, 2) };
  });

  // FODEC : taux × HT (après remise globale) des lignes soumises ; il s'ajoute au HT AVANT la TVA (base TVA = HT + FODEC).
  let totalHt = 0n; let totalTax = 0n; let lineNetSum = 0n; let totalFodec = 0n;
  const taxes = [...byRate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([rate, { sum: sumNet, fodecSum }]) => {
    lineNetSum += sumNet;
    const base = divRound(sumNet * (10000n - gPct), 10n ** 4n);
    const fodec = divRound(divRound(fodecSum * (10000n - gPct), 10n ** 4n) * fRate, 10n ** 4n);
    const vatBase = base + fodec;
    const tax = divRound(vatBase * rate, 10n ** 4n);
    totalHt += base; totalFodec += fodec; totalTax += tax;
    return { taxRate: fromScaled(rate, 2), base: money(vatBase), amount: money(tax) };
  });

  const totalTtc = totalHt + totalFodec + totalTax;
  const stamp = toScaled(stampDuty, 3);
  const withholding = divRound(totalTtc * wPct, 10n ** 4n);
  const netPayable = totalTtc + stamp - withholding;

  return {
    lines: outLines,
    taxes,
    subtotal: money(lineNetSum),                 // Σ nets de lignes (après remises de ligne)
    lineDiscountTotal: money(grossTotal - lineNetSum),
    globalDiscountAmount: money(lineNetSum - totalHt),
    totalHt: money(totalHt),
    fodecRate: fromScaled(fRate, 2),
    fodecAmount: money(totalFodec),
    totalTax: money(totalTax),
    totalTtc: money(totalTtc),
    stampDuty: money(stamp),
    withholdingAmount: money(withholding),
    netPayable: money(netPayable),
  };
}

// Les résultats de soustraction peuvent être négatifs (ex. avoir + règlements supérieurs au net à payer) : ces trois
// fonctions acceptent un signe « - » ; toScaled, utilisé pour valider les saisies, reste strict.
const signed = (v) => { const t = String(v ?? '0').trim(); return t.startsWith('-') ? -toScaled(t.slice(1), 3) : toScaled(t, 3); };
// Comparaison / somme décimales sûres pour les contrôles métier (solde, plafond d'avoir…)
export const addMoney = (a, b) => money(signed(a) + signed(b));
export const subMoney = (a, b) => money(signed(a) - signed(b));
export const cmpMoney = (a, b) => { const x = signed(a); const y = signed(b); return x < y ? -1 : x > y ? 1 : 0; };
export { S3 };
