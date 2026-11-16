// Logistique d'une facture de vente DIRECTE (sans commande ni bon de livraison amont).
// Règle d'or : une marchandise ne sort du stock qu'UNE fois. Deux chemins, jamais les deux :
//   (1) la facture sort le stock à l'émission (option « stockExit ») ;
//   (2) sinon, le bon de livraison généré depuis la facture sort le stock à sa validation.
// Si la facture a déjà sorti le stock, le BL généré est un simple document (stock_impact = 0).
import { z } from 'zod';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { ensureDefaultWarehouse, findWarehouse, moveStock, reverseSource } from '../stock/stock.service.js';
import { getSettings } from '../companies/settings.js';
import { fromScaled, toScaled } from '../../core/calc.js';
import { todayTunis } from './common.js';

export const stockExitOpts = { stockExit: z.boolean().optional(), warehouseId: z.string().uuid().optional() };

// Champs de l'option « sortir du stock » ; interdite si le stock est déjà géré par une commande ou un bon de livraison (double sortie).
export async function stockExitFields(conn, auth, body, { linked = false } = {}) {
  if (!body.stockExit) return { stock_exit: 0, stock_warehouse_id: null };
  if (linked) throw new HttpError(422, 'STOCK_EXIT_NOT_ALLOWED', 'Cette facture provient d\'une commande ou d\'un bon de livraison : le stock sort par le bon de livraison (évite une double sortie)');
  const wh = body.warehouseId ? (await findWarehouse(conn, auth.companyId, body.warehouseId)).id : null;
  return { stock_exit: 1, stock_warehouse_id: wh };
}

const TRACKED_SQL = `SELECT l.id, l.quantity, l.product_id FROM invoice_lines l JOIN products p ON p.id = l.product_id
  WHERE l.invoice_id = ? AND p.track_stock = 1 AND p.type = 'product' ORDER BY l.position`;

// À l'émission : sortie des articles suivis, dans la MÊME transaction que la numérotation (tout ou rien).
// Le contrôle de disponibilité suit le réglage de l'entreprise « stock négatif autorisé » : s'il est désactivé, un stock insuffisant bloque l'émission (409 STOCK_INSUFFICIENT).
export async function issueStockExit(conn, auth, cur, number) {
  if (!auth.permissions.has('delivery.validate')) throw new HttpError(403, 'FORBIDDEN', 'Sortir des articles du stock exige le droit de valider une livraison');
  const [tracked] = await conn.query(TRACKED_SQL, [cur.id]);
  if (!tracked.length) throw new HttpError(422, 'NOTHING_TO_STOCK', 'Aucune ligne ne concerne un article suivi en stock : décochez « Sortir du stock » ou choisissez des articles');
  const whId = cur.stock_warehouse_id ?? await ensureDefaultWarehouse(conn, auth.companyId, auth.userId);
  const [[wh]] = await conn.query('SELECT status, name FROM warehouses WHERE id = ? AND company_id = ?', [whId, auth.companyId]);
  if (wh.status !== 'active') throw new HttpError(422, 'WAREHOUSE_ARCHIVED', `L'entrepôt « ${wh.name} » est archivé : choisissez un autre entrepôt`);
  await moveStock(conn, { companyId: auth.companyId, userId: auth.userId }, tracked.map((t) => ({
    productId: t.product_id, warehouseId: whId, kind: 'delivery', quantity: `-${t.quantity}`, date: cur.issue_date_s, reason: `Facture ${number}`,
    source: { type: 'invoice', id: cur.public_id, number, lineId: t.id } })));
  await conn.query('UPDATE invoices SET stock_warehouse_id = ? WHERE id = ?', [whId, cur.id]);
  return tracked.length;
}

// Annulation : mouvements inverses (les sorties reviennent au coût d'origine). Rien ne s'efface du journal.
export async function reverseStockExit(conn, auth, cur) {
  return reverseSource(conn, { companyId: auth.companyId, userId: auth.userId }, { companyId: auth.companyId, type: 'invoice', id: cur.public_id, number: cur.number, kinds: ['delivery'], reverseKind: 'delivery_reversal', date: todayTunis(), reason: `Annulation facture ${cur.number}` });
}

// Contrôle indicatif avant émission (aucune écriture) : disponible / demandé par article suivi, pour l'entrepôt choisi.
export async function stockCheck(conn, auth, { warehouseId, lines }) {
  const whId = warehouseId ? (await findWarehouse(conn, auth.companyId, warehouseId)).id : await ensureDefaultWarehouse(conn, auth.companyId, auth.userId);
  const allowNegative = (await getSettings(auth.companyId, conn)).stock.allowNegative;
  const wanted = new Map();
  for (const l of lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0n) + toScaled(l.quantity, 4));
  const out = [];
  for (const [pid, q] of wanted) {
    const [[p]] = await conn.query('SELECT id, name, track_stock, type FROM products WHERE company_id = ? AND public_id = ?', [auth.companyId, pid]);
    if (!p || !p.track_stock || p.type !== 'product') continue;
    const [[lv]] = await conn.query('SELECT COALESCE(quantity, 0) AS q FROM stock_levels WHERE product_id = ? AND warehouse_id = ?', [p.id, whId]);
    const avail = toScaled(lv?.q ?? '0', 4);
    out.push({ productId: pid, name: p.name, available: fromScaled(avail, 4), requested: fromScaled(q, 4), insufficient: avail < q });
  }
  const short = out.some((o) => o.insufficient);
  return { warehouseId: whId, allowNegative, items: out, willBlock: short && !allowNegative, hasShortage: short };
}

// Lignes livrables : tout sauf les services (articles suivis ou non, et lignes libres).
const DELIVERABLE_SQL = `SELECT l.id, l.position, l.product_id, l.description, l.quantity, l.unit FROM invoice_lines l LEFT JOIN products p ON p.id = l.product_id
  WHERE l.invoice_id = ? AND (l.product_id IS NULL OR p.type = 'product') ORDER BY l.position`;

// État « peut-on générer un BL ? » calculé côté serveur (l'interface n'a qu'à l'afficher).
export async function deliveryNoteState(conn, inv) {
  const [bls] = await conn.query('SELECT public_id, number, status, stock_impact FROM delivery_notes WHERE source_invoice_id = ? ORDER BY id', [inv.id]);
  const active = bls.find((b) => b.status !== 'cancelled');
  let reason = null;
  if (inv.status !== 'issued') reason = 'La facture doit être émise';
  else if (inv.order_id || inv.delivery_note_id) reason = 'Cette facture provient d\'une commande ou d\'un bon de livraison : la livraison est suivie par ce circuit';
  else if (active) reason = `Un bon de livraison existe déjà (${active.number ?? 'brouillon'})`;
  else { const [d] = await conn.query(DELIVERABLE_SQL, [inv.id]); if (!d.length) reason = 'Aucune ligne livrable (services uniquement)'; }
  return { notes: bls.map((b) => ({ id: b.public_id, number: b.number, status: b.status, stockImpact: !!b.stock_impact })), can: !reason, reason };
}

// POST /invoices/:id/delivery-note : crée un BL BROUILLON pré-rempli depuis les lignes de la facture, lié à celle-ci.
export async function createDeliveryNoteFromInvoice(conn, auth, publicId, body, ip) {
  const [[inv]] = await conn.query("SELECT * FROM invoices WHERE company_id = ? AND public_id = ? AND kind = 'invoice' FOR UPDATE", [auth.companyId, publicId]);
  if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Facture introuvable');
  const st = await deliveryNoteState(conn, inv);
  if (!st.can) throw new HttpError(409, 'DELIVERY_NOT_ALLOWED', st.reason, { existing: st.notes.filter((n) => n.status !== 'cancelled') });
  const [lines] = await conn.query(DELIVERABLE_SQL, [inv.id]);
  const snap = typeof inv.client_snapshot === 'string' ? JSON.parse(inv.client_snapshot) : inv.client_snapshot;
  const whId = body.warehouseId ? (await findWarehouse(conn, auth.companyId, body.warehouseId)).id : (inv.stock_warehouse_id ?? await ensureDefaultWarehouse(conn, auth.companyId, auth.userId));
  const date = body.deliveryDate ?? todayTunis();
  if (date > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date de livraison est dans le futur');
  const noteId = newPublicId();
  const [r] = await conn.query(
    `INSERT INTO delivery_notes (public_id, company_id, status, order_id, source_invoice_id, stock_impact, warehouse_id, client_id, client_snapshot, delivery_date, delivery_address, notes, created_by)
     VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
    [noteId, auth.companyId, 'draft', inv.id, inv.stock_exit ? 0 : 1, whId, inv.client_id, JSON.stringify(snap), date, snap.address ?? null, `Généré depuis la facture ${inv.number}`, auth.userId]);
  let pos = 0;
  for (const l of lines) {
    pos += 1;
    await conn.query('INSERT INTO delivery_note_lines (delivery_note_id, order_line_id, invoice_line_id, product_id, position, description, quantity, unit) VALUES (?,?,?,?,?,?,?,?)', [r.insertId, null, l.id, l.product_id, pos, l.description, l.quantity, l.unit]);
  }
  await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'delivery.create_from_invoice', entityType: 'delivery_notes', entityId: noteId, ip, meta: { invoice: inv.number, lines: lines.length, stockImpact: !inv.stock_exit } });
  return noteId;
}
