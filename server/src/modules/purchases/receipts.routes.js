// Réceptions fournisseur : quantités reçues par ligne de commande. La validation fait ENTRER en stock les articles suivis
// (au coût de la commande, remise globale et change inclus), dans la même transaction que la numérotation : tout ou rien.
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { nextDocNumber } from '../../core/numbering.js';
import { fromScaled, toScaled } from '../../core/calc.js';
import { listQuerySchema, escapeLike, orderBy } from '../../core/list.js';
import { applyAdvanced, rangeShape, pageOf, isExport, exportCsv, csvDate, csvMoney, parseSnap } from '../../core/list-filters.js';
import { clientSnapshot, companySnapshot, history, idParam, loadLines, qtySchema, todayTunis } from '../sales/common.js';
import { ensureDefaultWarehouse, findWarehouse, moveStock, reverseSource } from '../stock/stock.service.js';
import { receivedByLine } from './orders.routes.js';
import { receiptUnitCost } from './common.js';

const router = Router();
router.use(authenticate);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const opt = (s) => z.preprocess((v) => (v === '' ? null : v), s.nullable().optional());
const body = z.object({
  orderId: z.string().uuid(), warehouseId: z.string().uuid().optional(), receiptDate: iso, vehiclePlate, supplierRef: opt(z.string().trim().max(60)), notes: opt(z.string().trim().max(3000)),
  lines: z.array(z.object({ orderLineId: z.coerce.number().int().positive(), quantity: qtySchema })).min(1, 'Au moins une ligne').max(200),
});
import { vehiclePlate } from '../../utils/plate.js';
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function findReceipt(conn, companyId, publicId, { forUpdate = false } = {}) {
  const [[r]] = await conn.query(
    `SELECT r.*, DATE_FORMAT(r.receipt_date,'%Y-%m-%d') AS receipt_date_s, s.public_id AS supplier_pid, o.public_id AS order_pid, o.number AS order_number, pi.public_id AS src_inv_pid, pi.number AS src_inv_number, w.public_id AS wh_pid, w.name AS wh_name
     FROM purchase_receipts r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders o ON o.id = r.order_id LEFT JOIN purchase_invoices pi ON pi.id = r.source_invoice_id LEFT JOIN warehouses w ON w.id = r.warehouse_id
     WHERE r.company_id = ? AND r.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId]);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Réception introuvable');
  return r;
}

async function dto(conn, companyId, publicId) {
  const r = await findReceipt(conn, companyId, publicId);
  const [lines] = await conn.query('SELECT * FROM purchase_receipt_lines WHERE purchase_receipt_id = ? ORDER BY position', [r.id]);
  const [[inv]] = await conn.query("SELECT public_id, number, status FROM purchase_invoices WHERE receipt_id = ? AND status <> 'cancelled'", [r.id]); // (un BR issu d'une facture n'est jamais re-facturé)
  const snap = parse(r.supplier_snapshot);
  const [mv] = await conn.query("SELECT kind, quantity, unit_cost FROM stock_movements WHERE company_id = ? AND source_type = 'purchase_receipt' AND source_id = ? ORDER BY id", [companyId, r.public_id]);
  return {
    id: r.public_id, number: r.number, status: r.status, supplierId: r.supplier_pid, supplierName: snap.name, supplier: snap, client: snap, company: r.company_snapshot ? parse(r.company_snapshot) : null,
    order: r.order_pid ? { id: r.order_pid, number: r.order_number } : null, sourceInvoice: r.src_inv_pid ? { id: r.src_inv_pid, number: r.src_inv_number } : null, warehouse: r.wh_pid ? { id: r.wh_pid, name: r.wh_name } : null, receiptDate: r.receipt_date_s, supplierRef: r.supplier_ref, vehiclePlate: r.vehicle_plate, notes: r.notes, cancelReason: r.cancel_reason,
    lines: lines.map((l) => ({ id: l.id, orderLineId: l.order_line_id, position: l.position, description: l.description, quantity: l.quantity, unit: l.unit })),
    invoice: inv ? { id: inv.public_id, number: inv.number, status: inv.status } : null, stockMovements: mv.length, createdAt: r.created_at,
  };
}

router.get(['/', '/export'], requirePermission('purchase_receipt.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ ...rangeShape, status: z.enum(['draft', 'validated', 'cancelled']).optional(), supplierId: z.string().uuid().optional(), orderId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['r.company_id = ?']; const params = [req.auth.companyId];
  if (q.status) { where.push('r.status = ?'); params.push(q.status); }
  if (q.supplierId) { where.push('s.public_id = ?'); params.push(q.supplierId); }
  if (q.orderId) { where.push('o.public_id = ?'); params.push(q.orderId); }
  applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'r', dateCol: 'receipt_date', partyCols: ['r.number', 's.name', 'o.number', 'pi.number', 'r.supplier_ref'], notesCol: 'notes', linesTable: 'purchase_receipt_lines', linesFk: 'purchase_receipt_id', orderLinesTable: 'purchase_order_lines' });
  const from = 'FROM purchase_receipts r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders o ON o.id = r.order_id LEFT JOIN purchase_invoices pi ON pi.id = r.source_invoice_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const SORT = { id: 'r.id', number: 'r.number', date: 'r.receipt_date', supplier: 's.name' };
  const [rows] = await pool.query(`SELECT r.public_id, r.number, r.status, r.supplier_ref, DATE_FORMAT(r.receipt_date,'%Y-%m-%d') AS d, s.name AS supplier_name, s.public_id AS supplier_pid, o.number AS order_number, o.public_id AS order_pid, pi.number AS src_inv_number, pi.public_id AS src_inv_pid,
      (SELECT public_id FROM purchase_invoices i WHERE i.receipt_id = r.id AND i.status <> 'cancelled' LIMIT 1) AS invoice_pid
    ${from} WHERE ${where.join(' AND ')} ORDER BY ${orderBy(q.sort ?? 'date', q.order === 'asc' && !q.sort ? 'desc' : q.order, SORT, 'date')} LIMIT ? OFFSET ?`, [...params, pageOf(req).limit, pageOf(req).offset]);
  if (isExport(req)) return exportCsv(req, res, { rows, total, file: 'bons-de-reception.csv', action: 'purchase_receipt.export', entity: 'purchase_receipts', headers: ['N°', 'Statut', 'Date', 'Fournisseur', 'N° fournisseur', 'Commande', 'Facture source'], row: (r) => [r.number ?? '', ({ draft: 'Brouillon', validated: 'Validé', cancelled: 'Annulé' })[r.status] ?? r.status, csvDate(r.d), r.supplier_name, r.supplier_ref ?? '', r.order_number ?? '', r.src_inv_number ?? ''] });
  res.json({ data: rows.map((r) => ({ id: r.public_id, number: r.number, status: r.status, receiptDate: r.d, supplierRef: r.supplier_ref, supplierId: r.supplier_pid, supplierName: r.supplier_name, order: r.order_pid ? { id: r.order_pid, number: r.order_number } : null, sourceInvoice: r.src_inv_pid ? { id: r.src_inv_pid, number: r.src_inv_number } : null, invoiced: !!r.invoice_pid })),
    meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
}));
router.get('/:id', requirePermission('purchase_receipt.read'), validate({ params: idParam }), asyncHandler(async (req, res) => { res.json({ data: await dto(pool, req.auth.companyId, req.params.id) }); }));
router.get('/:id/history', requirePermission('purchase_receipt.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await findReceipt(pool, req.auth.companyId, req.params.id);
  res.json({ data: await history(req.auth.companyId, 'purchase_receipts', req.params.id) });
}));

// Quantités : ligne de la commande, pas de doublon, quantité <= reste à recevoir (hors cette réception)
async function checkLines(conn, order, b, statuses, receiptId = 0) {
  const { lines: oLines } = await loadLines(conn, 'purchase_order', order.id);
  const taken = await receivedByLine(conn, order.id, statuses, receiptId);
  const seen = new Set(); const out = [];
  for (const [i, l] of b.lines.entries()) {
    const ol = oLines.find((x) => Number(x.id) === l.orderLineId);
    if (!ol) throw new HttpError(422, 'UNKNOWN_REFERENCE', `Ligne ${l.orderLineId} absente de la commande`);
    if (seen.has(ol.id)) throw new HttpError(422, 'DUPLICATE_LINE', 'Ligne en double');
    seen.add(ol.id);
    const q = toScaled(l.quantity, 4); const rest = toScaled(ol.quantity, 4) - (taken.get(Number(ol.id)) ?? 0n);
    if (q > rest) throw new HttpError(422, 'RECEIPT_EXCEEDS_ORDER', `Ligne ${ol.position} : quantité (${l.quantity}) supérieure au reste à recevoir (${fromScaled(rest > 0n ? rest : 0n, 4)})`);
    out.push({ orderLineId: ol.id, position: i + 1, description: ol.description, quantity: l.quantity, unit: ol.unit });
  }
  return out;
}
const writeLines = async (conn, id, lines) => {
  await conn.query('DELETE FROM purchase_receipt_lines WHERE purchase_receipt_id = ?', [id]);
  for (const l of lines) await conn.query('INSERT INTO purchase_receipt_lines (purchase_receipt_id, order_line_id, position, description, quantity, unit) VALUES (?,?,?,?,?,?)', [id, l.orderLineId, l.position, l.description, l.quantity, l.unit]);
};
const notFuture = (d) => { if (d > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date de réception est dans le futur'); };

router.post('/', requirePermission('purchase_receipt.write'), validate({ body }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const [[o]] = await conn.query('SELECT * FROM purchase_orders WHERE company_id = ? AND public_id = ? FOR UPDATE', [req.auth.companyId, req.body.orderId]);
    if (!o) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Commande introuvable');
    if (o.status !== 'confirmed') throw new HttpError(409, 'INVALID_STATE', 'La commande doit être confirmée pour créer une réception');
    const lines = await checkLines(conn, o, req.body, ['validated', 'draft']);
    const [[sup]] = await conn.query('SELECT * FROM suppliers WHERE id = ?', [o.supplier_id]);
    const whId = req.body.warehouseId ? (await findWarehouse(conn, req.auth.companyId, req.body.warehouseId)).id : await ensureDefaultWarehouse(conn, req.auth.companyId, req.auth.userId);
    const [r] = await conn.query('INSERT INTO purchase_receipts (public_id, company_id, status, order_id, supplier_id, supplier_snapshot, warehouse_id, receipt_date, supplier_ref, vehicle_plate, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [publicId, req.auth.companyId, 'draft', o.id, o.supplier_id, JSON.stringify(clientSnapshot(sup)), whId, req.body.receiptDate, req.body.supplierRef ?? null, req.body.vehiclePlate ?? null, req.body.notes ?? null, req.auth.userId]);
    await writeLines(conn, r.insertId, lines);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_receipt.create', entityType: 'purchase_receipts', entityId: publicId, ip: req.ip, meta: { order: o.number } });
  });
  res.status(201).json({ data: await dto(pool, req.auth.companyId, publicId) });
}));

router.put('/:id', requirePermission('purchase_receipt.write'), validate({ params: idParam, body: body.omit({ orderId: true }).extend({ lines: body.shape.lines.optional() }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findReceipt(conn, req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Une réception validée ne peut plus être modifiée : annulez-la et recréez-la');
    if (cur.source_invoice_id) { // BR généré depuis une facture : les lignes suivent la facture ; seuls la date, la référence, les notes et l'entrepôt se modifient
      const wh = req.body.warehouseId ? (await findWarehouse(conn, req.auth.companyId, req.body.warehouseId)).id : cur.warehouse_id;
      await conn.query('UPDATE purchase_receipts SET receipt_date = ?, supplier_ref = ?, vehicle_plate = ?, notes = ?, warehouse_id = ? WHERE id = ?', [req.body.receiptDate, req.body.supplierRef ?? null, req.body.vehiclePlate ?? null, req.body.notes ?? null, wh, cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_receipt.update', entityType: 'purchase_receipts', entityId: cur.public_id, ip: req.ip });
      return;
    }
    if (!req.body.lines) throw new HttpError(422, 'VALIDATION_ERROR', 'Au moins une ligne');
    const [[o]] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [cur.order_id]);
    const lines = await checkLines(conn, o, req.body, ['validated', 'draft'], cur.id);
    const whId = req.body.warehouseId ? (await findWarehouse(conn, req.auth.companyId, req.body.warehouseId)).id : cur.warehouse_id;
    await conn.query('UPDATE purchase_receipts SET receipt_date = ?, supplier_ref = ?, vehicle_plate = ?, notes = ?, warehouse_id = ? WHERE id = ?', [req.body.receiptDate, req.body.supplierRef ?? null, req.body.vehiclePlate ?? null, req.body.notes ?? null, whId, cur.id]);
    await writeLines(conn, cur.id, lines);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_receipt.update', entityType: 'purchase_receipts', entityId: cur.public_id, ip: req.ip });
  });
  res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
}));

router.delete('/:id', requirePermission('purchase_receipt.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findReceipt(conn, req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Seul un brouillon peut être supprimé ; une réception validée s\'annule');
    await conn.query('DELETE FROM purchase_receipts WHERE id = ?', [cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_receipt.delete', entityType: 'purchase_receipts', entityId: cur.public_id, ip: req.ip });
  });
  res.status(204).end();
}));

router.post('/:id/validate', requirePermission('purchase_receipt.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findReceipt(conn, req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'INVALID_TRANSITION', 'Cette réception est déjà validée ou annulée');
    notFuture(cur.receipt_date_s);
    let o; // document de coût : la commande, ou la facture d'achat source
    if (cur.source_invoice_id) {
      [[o]] = await conn.query('SELECT * FROM purchase_invoices WHERE id = ? FOR UPDATE', [cur.source_invoice_id]);
      if (o.status !== 'recorded') throw new HttpError(409, 'INVALID_STATE', 'La facture source n\'est plus enregistrée');
      if (o.stock_entry) throw new HttpError(409, 'ALREADY_IN_STOCK', 'Les articles sont déjà entrés en stock par la facture');
    } else {
      [[o]] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [cur.order_id]);
      if (o.status !== 'confirmed') throw new HttpError(409, 'INVALID_STATE', 'La commande n\'est plus confirmée');
      const [rows] = await conn.query('SELECT order_line_id, quantity FROM purchase_receipt_lines WHERE purchase_receipt_id = ?', [cur.id]);
      await checkLines(conn, o, { lines: rows.map((r) => ({ orderLineId: Number(r.order_line_id), quantity: String(r.quantity) })) }, ['validated'], cur.id);
    }
    const series = cur.receipt_date_s.slice(0, 4);
    const number = await nextDocNumber(conn, req.auth.companyId, 'purchase_receipt', series);
    const [[sup]] = await conn.query('SELECT * FROM suppliers WHERE id = ?', [cur.supplier_id]);
    const whId = cur.warehouse_id ?? await ensureDefaultWarehouse(conn, req.auth.companyId, req.auth.userId);
    const [tracked] = await conn.query(
      cur.source_invoice_id
        ? `SELECT rl.id, rl.quantity, il.product_id, il.net_amount, il.quantity AS order_quantity FROM purchase_receipt_lines rl JOIN purchase_invoice_lines il ON il.id = rl.invoice_line_id JOIN products p ON p.id = il.product_id
           WHERE rl.purchase_receipt_id = ? AND p.track_stock = 1 AND p.type = 'product' ORDER BY rl.position`
        : `SELECT rl.id, rl.quantity, ol.product_id, ol.net_amount, ol.quantity AS order_quantity FROM purchase_receipt_lines rl JOIN purchase_order_lines ol ON ol.id = rl.order_line_id JOIN products p ON p.id = ol.product_id
           WHERE rl.purchase_receipt_id = ? AND p.track_stock = 1 AND p.type = 'product' ORDER BY rl.position`, [cur.id]);
    if (tracked.length) {
      const [[wh]] = await conn.query('SELECT status, name FROM warehouses WHERE id = ? AND company_id = ?', [whId, req.auth.companyId]);
      if (wh.status !== 'active') throw new HttpError(422, 'WAREHOUSE_ARCHIVED', `L'entrepôt « ${wh.name} » est archivé : choisissez un autre entrepôt`);
      await moveStock(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, tracked.map((t) => ({
        productId: t.product_id, warehouseId: whId, kind: 'entry', quantity: String(t.quantity), unitCost: receiptUnitCost(o, { net_amount: t.net_amount, quantity: t.order_quantity }),
        date: cur.receipt_date_s, reason: `Réception ${number}`, source: { type: 'purchase_receipt', id: cur.public_id, number, lineId: t.id } })));
    }
    await conn.query("UPDATE purchase_receipts SET warehouse_id = ?, status = 'validated', number = ?, series = ?, validated_at = UTC_TIMESTAMP(), validated_by = ?, supplier_snapshot = ?, company_snapshot = ? WHERE id = ?",
      [whId, number, series, req.auth.userId, JSON.stringify(clientSnapshot(sup)), JSON.stringify(await companySnapshot(conn, req.auth.companyId)), cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_receipt.validate', entityType: 'purchase_receipts', entityId: cur.public_id, ip: req.ip, meta: { number, order: cur.source_invoice_id ? null : o.number, invoice: cur.source_invoice_id ? o.number : null, stockLines: tracked.length } });
  });
  res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
}));

router.post('/:id/cancel', requirePermission('purchase_receipt.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findReceipt(conn, req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'validated') throw new HttpError(409, 'INVALID_TRANSITION', 'Seule une réception validée peut être annulée (un brouillon se supprime)');
    const [[inv]] = await conn.query("SELECT COUNT(*) AS n FROM purchase_invoices WHERE receipt_id = ? AND status <> 'cancelled'", [cur.id]);
    if (inv.n) throw new HttpError(409, 'HAS_INVOICES', 'Une facture d\'achat existe pour cette réception : annulez-la d\'abord');
    const [[rets]] = await conn.query("SELECT COUNT(*) AS n FROM purchase_returns WHERE receipt_id = ? AND status IN ('draft','validated')", [cur.id]);
    if (rets.n) throw new HttpError(409, 'HAS_RETURNS', 'Des retours fournisseur existent pour cette réception : annulez-les d\'abord');
    // l'entrée en stock est annulée par un mouvement inverse (le journal n'est jamais modifié)
    await reverseSource(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, { companyId: req.auth.companyId, type: 'purchase_receipt', id: cur.public_id, number: cur.number, kinds: ['entry'], reverseKind: 'cancellation', date: todayTunis(), reason: `Annulation de la réception ${cur.number}` });
    await conn.query("UPDATE purchase_receipts SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [req.body.reason, cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_receipt.cancel', entityType: 'purchase_receipts', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number, reason: req.body.reason } });
  });
  res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
}));

export default router;
