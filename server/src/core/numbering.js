// Numerotation atomique par entreprise, type et serie. A appeler DANS une transaction :
// l'upsert pose un verrou de ligne tenu jusqu'au commit -> creations concurrentes serialisees,
// pas de doublon, et pas de trou si la transaction est annulee. LAST_INSERT_ID(expr) renvoie le numero attribue.
export async function nextNumber(conn, companyId, docType, series = '') {
  const [r] = await conn.query(
    `INSERT INTO document_sequences (company_id, doc_type, series, last_number) VALUES (?,?,?,LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`,
    [companyId, docType, series],
  );
  return Number(r.insertId);
}

export const formatCode = (prefix, n, width = 5) => `${prefix}-${String(n).padStart(width, '0')}`;

// ---------------------------------------------------------------------------------------------
// Numérotation CONFIGURABLE des documents (préfixe, séparateur, année, remise à zéro, largeur).
// Réglages enregistrés par entreprise dans company_settings.numbering ; valeurs par défaut = format historique FAC-2026-00001.
// Un numéro déjà attribué n'est JAMAIS modifié : un changement de réglage ne vaut que pour les documents créés ensuite.
// Le compteur ne peut qu'augmenter (document_sequences) ; le préfixe doit être unique par entreprise (deux types ne partagent jamais un préfixe).
// ---------------------------------------------------------------------------------------------
export const DOC_TYPES = {
  quote: { label: 'Devis', group: 'Ventes', prefix: 'DEV' },
  sales_order: { label: 'Bon de commande client', group: 'Ventes', prefix: 'CMD' },
  invoice: { label: 'Facture de vente', group: 'Ventes', prefix: 'FAC' },
  credit_note: { label: 'Avoir client', group: 'Ventes', prefix: 'AVO' },
  delivery_note: { label: 'Bon de livraison', group: 'Ventes', prefix: 'BL' },
  sales_return: { label: 'Retour client', group: 'Ventes', prefix: 'BRT' },
  payment: { label: 'Règlement client', group: 'Ventes', prefix: 'REG' },
  expense_note_sales: { label: 'Note de débours client', group: 'Ventes', prefix: 'DEB' },
  purchase_order: { label: 'Bon de commande fournisseur', group: 'Achats', prefix: 'BCF' },
  purchase_receipt: { label: 'Bon de réception', group: 'Achats', prefix: 'BR' },
  purchase_invoice: { label: "Facture d'achat", group: 'Achats', prefix: 'FA' },
  purchase_credit_note: { label: 'Avoir fournisseur', group: 'Achats', prefix: 'AVF' },
  purchase_return: { label: 'Retour fournisseur', group: 'Achats', prefix: 'RF' },
  supplier_payment: { label: 'Règlement fournisseur', group: 'Achats', prefix: 'RGF' },
  expense_note_purchase: { label: 'Note de débours fournisseur', group: 'Achats', prefix: 'DBA' },
  stock_entry: { label: "Bon d'entrée de stock", group: 'Stock et trésorerie', prefix: 'BEN' },
  stock_withdrawal: { label: 'Bon de prélèvement', group: 'Stock et trésorerie', prefix: 'BPR' },
  stock_transfer: { label: 'Bon de transfert', group: 'Stock et trésorerie', prefix: 'BTR' },
  stock_count: { label: "Inventaire", group: 'Stock et trésorerie', prefix: 'INV' },
  treasury_tx: { label: 'Opération de trésorerie', group: 'Stock et trésorerie', prefix: 'TRS' },
};
export const SEPARATORS = ['-', '/', '.', '_', ''];
export const DEFAULT_NUMBERING = { separator: '-', includeYear: true, yearlyReset: true, width: 5 };
export const configOf = (docType, stored) => ({ prefix: DOC_TYPES[docType].prefix, ...DEFAULT_NUMBERING, ...(stored ?? {}) });

// Construit le numéro : PRÉFIXE[sep][année sep]NNNNN. `year` = année de la série.
export function buildNumber(cfg, year, n) {
  const sep = cfg.separator ?? '';
  return `${cfg.prefix}${sep}${cfg.includeYear ? `${year}${sep}` : ''}${String(n).padStart(cfg.width, '0')}`;
}
export const seriesOf = (cfg, year) => (cfg.yearlyReset ? String(year) : '');

export async function getNumbering(conn, companyId) {
  const [[row]] = await conn.query('SELECT settings FROM company_settings WHERE company_id = ?', [companyId]);
  const st = row ? (typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings) : {};
  return st?.numbering ?? {};
}

/** Attribue le prochain numéro d'un type de document (à appeler DANS la transaction de création). `year` : année du document (4 chiffres). */
export async function nextDocNumber(conn, companyId, docType, year) {
  if (!DOC_TYPES[docType]) throw new Error(`Type de document inconnu : ${docType}`);
  const cfg = configOf(docType, (await getNumbering(conn, companyId))[docType]);
  const y = String(year).slice(0, 4);
  return buildNumber(cfg, y, await nextNumber(conn, companyId, docType, seriesOf(cfg, y)));
}
