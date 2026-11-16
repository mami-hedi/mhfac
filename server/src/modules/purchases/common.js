// Brique commune des achats : mêmes règles de calcul que les ventes (core/calc.js), côté fournisseur.
import { z } from 'zod';
import { HttpError } from '../../utils/httpError.js';
import { fromScaled, toScaled } from '../../core/calc.js';
import { bodyBase, commonDto, headerValues, prepare } from '../sales/common.js';

const { clientId: _client, ...rest } = bodyBase;
export const purchaseBase = { supplierId: z.string().uuid(), ...rest };
export const preparePurchase = (conn, auth, body) => prepare(conn, auth, body, { party: 'supplier' });
export const purchaseHeader = (p, body) => headerValues(p, body, 'supplier');

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const DATE = (col) => `DATE_FORMAT(d.${col}, '%Y-%m-%d') AS ${col}_s`;

// table : 'purchase_orders' | 'purchase_invoices'
export async function findPurchaseDoc(conn, table, companyId, publicId, { forUpdate = false } = {}) {
  const extra = table === 'purchase_orders' ? DATE('expected_date') : DATE('due_date');
  const [[row]] = await conn.query(
    `SELECT d.*, ${DATE('issue_date')}, ${extra}, s.public_id AS supplier_pid FROM ${table} d JOIN suppliers s ON s.id = d.supplier_id WHERE d.company_id = ? AND d.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`,
    [companyId, publicId]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Document introuvable');
  return row;
}

export const partyDto = (r) => {
  const { clientId, client, ...d } = commonDto({ ...r, client_pid: r.supplier_pid, client_snapshot: r.supplier_snapshot });
  return { supplierId: clientId, supplier: client, ...d };
};
export const supplierName = (r) => parse(r.supplier_snapshot).name;

// Taux de TVA actif pour un pourcentage (reprise de lignes de commande vers une facture)
export async function taxIdByRate(conn, companyId) {
  const [rows] = await conn.query('SELECT public_id, rate FROM tax_rates WHERE company_id = ? AND is_active = 1 ORDER BY is_default DESC, id', [companyId]);
  return (rate) => {
    const t = rows.find((x) => Number(x.rate) === Number(rate));
    if (!t) throw new HttpError(422, 'INACTIVE_TAX_RATE', `Aucun taux de TVA actif à ${Number(rate)} % : réactivez-le avant de continuer`);
    return t.public_id;
  };
}

// Coût unitaire d'entrée en stock (devise de la société, 4 décimales) d'une ligne de commande :
// net de ligne après remise globale / quantité commandée, converti au taux de change de la commande.
export function receiptUnitCost(order, line) {
  const gd = toScaled(order.global_discount_pct, 2);
  const net3 = (toScaled(line.net_amount, 3) * (10000n - gd) + 5000n) / 10000n; // remise globale en % à 2 décimales : 10,00 % -> 1000
  const q4 = toScaled(line.quantity, 4);
  let unit4 = (net3 * 100_000n * 2n + q4) / (q4 * 2n); // N3 * 1e5 / Q4, arrondi
  const rate6 = toScaled(order.exchange_rate, 6);
  if (rate6 !== 1_000_000n) unit4 = (unit4 * rate6 * 2n + 1_000_000n) / 2_000_000n;
  return fromScaled(unit4, 4);
}
