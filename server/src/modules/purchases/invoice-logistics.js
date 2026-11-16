// Logistique d'une facture d'achat DIRECTE (sans commande ni réception amont) : « Générer un Bon de Réception ».
// Règle d'or : une marchandise n'entre en stock qu'UNE fois. Deux chemins, jamais les deux :
//   (1) la facture fait entrer le stock à l'enregistrement (case « Entrer en stock ») ;
//   (2) sinon, le bon de réception généré depuis la facture fait entrer le stock à sa validation, au coût de la facture.
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { ensureDefaultWarehouse, findWarehouse } from '../stock/stock.service.js';
import { clientSnapshot, todayTunis } from '../sales/common.js';

const RECEIVABLE_SQL = `SELECT l.id, l.position, l.product_id, l.description, l.quantity, l.unit FROM purchase_invoice_lines l LEFT JOIN products p ON p.id = l.product_id
  WHERE l.purchase_invoice_id = ? AND (l.product_id IS NULL OR p.type = 'product') ORDER BY l.position`;

// État « peut-on générer un BR ? » calculé côté serveur (l'interface n'a qu'à l'afficher).
export async function receiptState(conn, inv) {
  const [brs] = await conn.query('SELECT public_id, number, status FROM purchase_receipts WHERE source_invoice_id = ? ORDER BY id', [inv.id]);
  const active = brs.find((b) => b.status !== 'cancelled');
  let reason = null;
  if (inv.kind !== 'invoice') reason = 'Un avoir ne donne pas lieu à une réception';
  else if (inv.status !== 'recorded') reason = 'La facture doit être enregistrée';
  else if (inv.stock_entry) reason = 'Les articles sont déjà entrés en stock par cette facture';
  else if (inv.order_id || inv.receipt_id) reason = 'Cette facture provient d\'une commande ou d\'une réception : l\'entrée en stock est suivie par ce circuit';
  else if (active) reason = `Un bon de réception existe déjà (${active.number ?? 'brouillon'})`;
  else { const [d] = await conn.query(RECEIVABLE_SQL, [inv.id]); if (!d.length) reason = 'Aucune ligne à réceptionner (services uniquement)'; }
  return { receipts: brs.map((b) => ({ id: b.public_id, number: b.number, status: b.status })), can: !reason, reason };
}

// POST /purchase-invoices/:id/receipt : crée un BR BROUILLON pré-rempli depuis les lignes de la facture, lié à celle-ci.
export async function createReceiptFromInvoice(conn, auth, publicId, body, ip) {
  const [[inv]] = await conn.query("SELECT * FROM purchase_invoices WHERE company_id = ? AND public_id = ? AND kind = 'invoice' FOR UPDATE", [auth.companyId, publicId]);
  if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Facture introuvable');
  const st = await receiptState(conn, inv);
  if (!st.can) throw new HttpError(409, inv.stock_entry ? 'ALREADY_IN_STOCK' : 'RECEIPT_NOT_ALLOWED', st.reason, { existing: st.receipts.filter((n) => n.status !== 'cancelled') });
  const [lines] = await conn.query(RECEIVABLE_SQL, [inv.id]);
  const [[sup]] = await conn.query('SELECT * FROM suppliers WHERE id = ?', [inv.supplier_id]);
  const whId = body.warehouseId ? (await findWarehouse(conn, auth.companyId, body.warehouseId)).id : await ensureDefaultWarehouse(conn, auth.companyId, auth.userId);
  const date = body.receiptDate ?? todayTunis();
  if (date > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date de réception est dans le futur');
  const id = newPublicId();
  const [r] = await conn.query(
    `INSERT INTO purchase_receipts (public_id, company_id, status, order_id, source_invoice_id, supplier_id, supplier_snapshot, warehouse_id, receipt_date, supplier_ref, notes, created_by)
     VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?)`,
    [id, auth.companyId, 'draft', inv.id, inv.supplier_id, JSON.stringify(clientSnapshot(sup)), whId, date, inv.supplier_ref, `Généré depuis la facture d'achat ${inv.number}`, auth.userId]);
  let pos = 0;
  for (const l of lines) {
    pos += 1;
    await conn.query('INSERT INTO purchase_receipt_lines (purchase_receipt_id, order_line_id, invoice_line_id, product_id, position, description, quantity, unit) VALUES (?,?,?,?,?,?,?,?)', [r.insertId, null, l.id, l.product_id, pos, l.description, l.quantity, l.unit]);
  }
  await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'purchase_receipt.create_from_invoice', entityType: 'purchase_receipts', entityId: id, ip, meta: { invoice: inv.number, lines: lines.length } });
  return id;
}
