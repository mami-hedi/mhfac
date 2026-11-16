// Préparation de la déclaration TEJ (retenue à la source opérée sur nos achats).
// IMPORTANT : ce n'est PAS le fichier XML officiel. Le schéma XSD de la DGI (CCT-RS-V2) n'est pas intégré ;
// ce module contrôle les données et produit un tableau de préparation (montants en millimes, comme TEJ).
import { toScaled } from '../../core/calc.js';

export const MF_RE = /^\d{7}[A-Z]$/; // matricule fiscal : 7 chiffres + 1 lettre majuscule (ex. 1234567A)
const mil = (v) => toScaled(v, 3); // BigInt millimes

// row : { number, supplierRef, supplierName, taxId, totalHt, totalTax, totalTtc, stampDuty, rate, amount, paymentDate }
export function checkRow(r) {
  const issues = [];
  const add = (code, message, level = 'error') => issues.push({ code, level, message });
  if (!r.taxId) add('TAXID_MISSING', `Matricule fiscal du fournisseur « ${r.supplierName} » manquant (ou CIN / passeport à renseigner autrement)`);
  else if (!MF_RE.test(String(r.taxId).replace(/[\s/.-]/g, '').toUpperCase())) add('TAXID_FORMAT', `Matricule fiscal « ${r.taxId} » : format attendu 7 chiffres + 1 lettre (ex. 1234567A) — à vérifier si c'est un CIN ou un passeport`, 'warning');
  if (!r.paymentDate) add('PAYMENT_DATE_MISSING', 'Aucun paiement enregistré : la date de paiement est requise par TEJ');
  const ht = mil(r.totalHt); const tva = mil(r.totalTax); const ttc = mil(r.totalTtc); const timbre = mil(r.stampDuty ?? '0'); const ret = mil(r.amount);
  if (ht + tva + timbre !== ttc) add('TOTALS_MISMATCH', 'HT + TVA (+ timbre) ≠ TTC : vérifier la facture');
  if (ret <= 0n) add('WITHHOLDING_ZERO', 'Retenue nulle');
  if (ret > ttc) add('WITHHOLDING_TOO_HIGH', 'La retenue dépasse le TTC');
  return issues;
}

export function toPrepRow(r) {
  const ht = mil(r.totalHt); const tva = mil(r.totalTax); const ttc = mil(r.totalTtc); const ret = mil(r.amount);
  return { reference: r.supplierRef || r.number, invoice: r.number, taxId: r.taxId ?? '', supplier: r.supplierName, paymentDate: r.paymentDate ?? '',
    ht: ht.toString(), tva: tva.toString(), ttc: ttc.toString(), rate: String(r.rate), retenue: ret.toString(), net: (ttc - ret).toString() };
}

// Une référence de certificat doit être unique dans un dépôt.
export function duplicateRefs(rows) {
  const seen = new Map(); const dup = new Set();
  for (const r of rows) { const k = String(r.reference); if (seen.has(k)) dup.add(k); seen.set(k, true); }
  return dup;
}

// ---- Contrôles supplémentaires nécessaires à la génération du XML TEJ ----
import { OPERATION_CODES, isCode } from './tej-codes.js';
import { isMf } from './tej-xml.js';
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const TVA_RATES = [0n, 7n, 13n, 19n]; // taux de TVA en vigueur listés par le cahier des charges
const hund = (v) => BigInt(Math.round(Number(v) * 100)); // taux en centièmes de %

/** Calcule la ligne d'opération TEJ (millimes) à partir de la facture ; retourne { op, issues } */
export function tejOperation(r) {
  const issues = []; const add = (code, message) => issues.push({ code, level: 'error', message });
  if (!r.operationCode) add('OPERATION_CODE_MISSING', "Code d'opération TEJ non choisi (ex. RS7_000001 pour un achat ≥ 1 000 DT)");
  else if (!isCode(r.operationCode)) add('OPERATION_CODE_UNKNOWN', `Code d'opération « ${r.operationCode} » inconnu`);
  const def = OPERATION_CODES[r.operationCode];
  const ht = toScaled(r.totalHt, 3); const tva = toScaled(r.totalTax, 3); const ttc = ht + tva; const rs = toScaled(r.amount, 3);
  if (def && hund(r.rate) !== hund(def.rate)) add('RATE_MISMATCH', `Taux de retenue de la facture (${r.rate} %) ≠ taux du code ${def.code} (${def.rate} %)`);
  // MontantRS = MontantTTC × TauxRS (arrondi au millime) — le montant de la facture fait foi, on ne le recalcule jamais en silence
  const expected = (ttc * hund(r.rate) + 5000n) / 10000n;
  if (expected !== rs) add('RS_AMOUNT_MISMATCH', `Retenue de la facture (${r.amount}) ≠ TTC × taux (${expected} millimes) : vérifier la facture`);
  const tauxTva = ht === 0n ? 0n : (tva * 10000n + ht / 2n) / ht; // centièmes de %
  if (!TVA_RATES.some((t) => t * 100n === tauxTva) || (ht * tauxTva + 5000n) / 10000n !== tva) add('VAT_NOT_SINGLE_RATE', 'TVA à taux multiples ou taux non standard (0, 7, 13, 19 %) : TEJ attend un seul taux par opération — à saisir à la main sur TEJ');
  if (r.currency && r.currency !== 'TND') add('FOREIGN_CURRENCY', 'Facture en devise : bloc Devise non pris en charge pour le moment — saisie manuelle sur TEJ');
  if (r.operationCode?.startsWith('RS7_') && ttc < 1000000n && def?.rate !== '0.00') add('BELOW_THRESHOLD', 'RS7 : la retenue ne s\'applique qu\'aux montants ≥ 1 000 DT TTC');
  if (!r.taxId || !isMf(r.taxId)) add('BENEFICIARY_ID', 'Bénéficiaire : matricule fiscal valide requis (CIN, passeport et carte de séjour non pris en charge pour le moment)');
  if (!r.supplierAddress) add('BENEFICIARY_ADDRESS', 'Adresse du fournisseur requise par TEJ');
  if (!r.supplierEmail || !EMAIL_RE.test(r.supplierEmail)) add('BENEFICIARY_EMAIL', 'E-mail valide du fournisseur requis par TEJ');
  if (!r.supplierPhone) add('BENEFICIARY_PHONE', 'Téléphone du fournisseur requis par TEJ');
  if (r.paidTotal != null && toScaled(r.paidTotal, 3) < toScaled(r.netPayable, 3)) issues.push({ code: 'PARTIAL_PAYMENT', level: 'warning', message: 'Paiement partiel : la retenue est déclarée pour toute la facture — vérifiez avec votre comptable' });
  const year = r.issueDate ? r.issueDate.slice(0, 4) : null;
  const op = { code: r.operationCode, year, cnpc: r.cnpc ? 1 : 0, pCharge: r.pCharge ? 1 : 0, ht: ht.toString(), tva: tva.toString(), ttc: ttc.toString(), taux: def?.rate ?? r.rate, tauxTva: (Number(tauxTva) / 100).toString(), rs: rs.toString(), net: (ttc - rs).toString() };
  return { op, issues };
}
