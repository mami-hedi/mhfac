// Commandes fournisseur : brouillon -> confirmée (ou annulée). Réception et facturation sont DÉRIVÉES (réceptions validées, factures actives).
import { fileSafe } from '../../utils/filename.js';
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
import { clientSnapshot, companySnapshot, history, idParam, lineDto, loadLines, writeLines, bodyBase } from '../sales/common.js';
import { findPurchaseDoc, partyDto, preparePurchase, purchaseBase, purchaseHeader, supplierName } from './common.js';
import { renderDocumentPdf } from '../sales/pdf.js';
import { attachEmailRoutes } from '../sales/email.js';

const router = Router();
router.use(authenticate);
const orderBody = z.object({ ...purchaseBase, expectedDate: bodyBase.issueDate.optional().nullable() });

// quantités reçues par ligne de commande (réceptions dans les statuts demandés)
export async function receivedByLine(conn, orderId, statuses, excludeId = 0) {
  const [rows] = await conn.query(
    `SELECT l.order_line_id, SUM(l.quantity) AS q FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.id = l.purchase_receipt_id
     WHERE r.order_id = ? AND r.status IN (?) AND r.id <> ? GROUP BY l.order_line_id`, [orderId, statuses, excludeId]);
  return new Map(rows.map((r) => [Number(r.order_line_id), toScaled(r.q, 4)]));
}
async function activeInvoices(conn, orderId) {
  const [rows] = await conn.query("SELECT id, public_id, number, status, receipt_id FROM purchase_invoices WHERE order_id = ? AND kind = 'invoice' AND status <> 'cancelled' ORDER BY id", [orderId]);
  return rows;
}
const derive = (lines, received, invoices) => {
  const total = lines.reduce((a, l) => a + toScaled(l.quantity, 4), 0n);
  const done = lines.reduce((a, l) => a + (received.get(Number(l.id)) ?? 0n), 0n);
  return {
    receiptStatus: done === 0n ? 'none' : done >= total ? 'complete' : 'partial',
    invoicingStatus: invoices.some((i) => !i.receipt_id) ? 'invoiced' : invoices.length ? 'partial' : 'none',
  };
};

export async function orderDto(conn, companyId, publicId) {
  const r = await findPurchaseDoc(conn, 'purchase_orders', companyId, publicId);
  const { lines, taxes } = await loadLines(conn, 'purchase_order', r.id);
  const received = await receivedByLine(conn, r.id, ['validated']);
  const reserved = await receivedByLine(conn, r.id, ['validated', 'draft']);
  const invoices = await activeInvoices(conn, r.id);
  const [notes] = await conn.query("SELECT public_id, number, status, DATE_FORMAT(receipt_date,'%Y-%m-%d') AS d FROM purchase_receipts WHERE order_id = ? ORDER BY id", [r.id]);
  const [allInv] = await conn.query("SELECT public_id, number, status, supplier_ref, total_ttc, net_payable FROM purchase_invoices WHERE order_id = ? AND kind = 'invoice' ORDER BY id", [r.id]);
  const dto = partyDto(r);
  return {
    id: r.public_id, number: r.number, status: r.status, ...dto, client: dto.supplier, supplierName: supplierName(r), expectedDate: r.expected_date_s, cancelReason: r.cancel_reason, ...derive(lines, received, invoices),
    lines: lines.map((l) => {
      const del = received.get(Number(l.id)) ?? 0n; const res = reserved.get(Number(l.id)) ?? 0n; const q = toScaled(l.quantity, 4);
      return { ...lineDto(l), receivedQuantity: fromScaled(del, 4), remainingQuantity: fromScaled(q - del, 4), receivableQuantity: fromScaled(q - res > 0n ? q - res : 0n, 4) };
    }),
    taxes: taxes.map((t) => ({ taxRate: t.tax_rate, base: t.base, amount: t.amount })),
    receipts: notes.map((n) => ({ id: n.public_id, number: n.number, status: n.status, date: n.d })),
    invoices: allInv.map((i) => ({ id: i.public_id, number: i.number, status: i.status, supplierRef: i.supplier_ref, totalTtc: i.total_ttc, netPayable: i.net_payable })),
  };
}

router.get(['/', '/export'], requirePermission('purchase.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ ...rangeShape, status: z.enum(['draft', 'confirmed', 'cancelled']).optional(), supplierId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['d.company_id = ?']; const params = [req.auth.companyId];
  if (q.status) { where.push('d.status = ?'); params.push(q.status); }
  if (q.supplierId) { where.push('s.public_id = ?'); params.push(q.supplierId); }
  applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'd', dateCol: 'issue_date', totalCol: 'total_ttc', partyCols: ['d.number', 's.name'], notesCol: 'notes', linesTable: 'purchase_order_lines', linesFk: 'purchase_order_id', hasProject: true });
  const from = 'FROM purchase_orders d JOIN suppliers s ON s.id = d.supplier_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const SORT = { id: 'd.id', number: 'd.number', date: 'd.issue_date', total: 'd.total_ttc', supplier: 's.name' };
  const [rows] = await pool.query(`SELECT d.*, DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS issue_date_s, DATE_FORMAT(d.expected_date,'%Y-%m-%d') AS expected_date_s, s.public_id AS supplier_pid,
      (SELECT COALESCE(SUM(l.quantity),0) FROM purchase_order_lines l WHERE l.purchase_order_id = d.id) AS q_total,
      (SELECT COALESCE(SUM(rl.quantity),0) FROM purchase_receipt_lines rl JOIN purchase_receipts r ON r.id = rl.purchase_receipt_id WHERE r.order_id = d.id AND r.status = 'validated') AS q_done,
      (SELECT COUNT(*) FROM purchase_invoices i WHERE i.order_id = d.id AND i.kind = 'invoice' AND i.status <> 'cancelled' AND i.receipt_id IS NULL) AS n_full,
      (SELECT COUNT(*) FROM purchase_invoices i WHERE i.order_id = d.id AND i.kind = 'invoice' AND i.status <> 'cancelled' AND i.receipt_id IS NOT NULL) AS n_rec
    ${from} WHERE ${where.join(' AND ')} ORDER BY ${orderBy(q.sort ?? 'date', q.order === 'asc' && !q.sort ? 'desc' : q.order, SORT, 'date')} LIMIT ? OFFSET ?`, [...params, pageOf(req).limit, pageOf(req).offset]);
  if (isExport(req)) return exportCsv(req, res, { rows, total, file: 'commandes-achat.csv', action: 'purchase_order.export', entity: 'purchase_orders', headers: ['N°', 'Statut', 'Date', 'Livraison prévue', 'Fournisseur', 'Devise', 'Total HT', 'Total TTC'], row: (r) => [r.number ?? '', ({ draft: 'Brouillon', confirmed: 'Confirmée', cancelled: 'Annulée' })[r.status] ?? r.status, csvDate(r.issue_date_s), csvDate(r.expected_date_s), supplierName(r), r.currency, csvMoney(r.total_ht), csvMoney(r.total_ttc)] });
  res.json({
    data: rows.map((r) => ({
      id: r.public_id, number: r.number, status: r.status, supplierId: r.supplier_pid, supplierName: supplierName(r), issueDate: r.issue_date_s, expectedDate: r.expected_date_s, currency: r.currency, totalHt: r.total_ht, totalTtc: r.total_ttc, netPayable: r.net_payable,
      receiptStatus: Number(r.q_done) === 0 ? 'none' : Number(r.q_done) >= Number(r.q_total) ? 'complete' : 'partial', invoicingStatus: r.n_full ? 'invoiced' : r.n_rec ? 'partial' : 'none',
    })),
    meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) },
  });
}));

router.get('/:id', requirePermission('purchase.read'), validate({ params: idParam }), asyncHandler(async (req, res) => { res.json({ data: await orderDto(pool, req.auth.companyId, req.params.id) }); }));
router.get('/:id/history', requirePermission('purchase.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await findPurchaseDoc(pool, 'purchase_orders', req.auth.companyId, req.params.id);
  res.json({ data: await history(req.auth.companyId, 'purchase_orders', req.params.id) });
}));
router.get('/:id/pdf', requirePermission('purchase.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const dto = await orderDto(pool, req.auth.companyId, req.params.id);
  const buf = await renderDocumentPdf({ kind: 'purchase_order', doc: dto, companyId: req.auth.companyId, template: req.query.template, lang: req.query.lang });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileSafe(dto.number)}.pdf"` }).send(buf);
}));
attachEmailRoutes(router, {
  type: 'purchase_order', perm: 'purchase', label: 'Bon de commande', entity: 'purchase_orders',
  fetchDoc: (conn, companyId, id) => orderDto(conn, companyId, id),
  render: (doc, companyId) => renderDocumentPdf({ kind: 'purchase_order', doc, companyId }),
  assertSendable: (doc) => { if (doc.status !== 'confirmed') throw new HttpError(409, 'INVALID_STATE', 'Seule une commande confirmée peut être envoyée'); },
});

const expected = (b) => {
  if (b.expectedDate && b.expectedDate < b.issueDate) throw new HttpError(422, 'INVALID_DATE', 'La date de livraison attendue précède la date de commande');
  return b.expectedDate ?? null;
};

router.post('/', requirePermission('purchase.write'), validate({ body: orderBody }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const p = await preparePurchase(conn, req.auth, req.body);
    const series = req.body.issueDate.slice(0, 4);
    const number = await nextDocNumber(conn, req.auth.companyId, 'purchase_order', series);
    const h = { ...purchaseHeader(p, req.body), public_id: publicId, company_id: req.auth.companyId, number, expected_date: expected(req.body), created_by: req.auth.userId };
    const [r] = await conn.query(`INSERT INTO purchase_orders (${Object.keys(h).join(',')}) VALUES (${Object.keys(h).map(() => '?').join(',')})`, Object.values(h));
    await writeLines(conn, 'purchase_order', r.insertId, p);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_order.create', entityType: 'purchase_orders', entityId: publicId, ip: req.ip, meta: { number, totalTtc: p.calc.totalTtc } });
  });
  res.status(201).json({ data: await orderDto(pool, req.auth.companyId, publicId) });
}));

router.put('/:id', requirePermission('purchase.write'), validate({ params: idParam, body: orderBody }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findPurchaseDoc(conn, 'purchase_orders', req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Une commande confirmée ne peut plus être modifiée : annulez-la et recréez-la');
    const p = await preparePurchase(conn, req.auth, req.body);
    const h = { ...purchaseHeader(p, req.body), expected_date: expected(req.body) };
    await conn.query(`UPDATE purchase_orders SET ${Object.keys(h).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(h), cur.id]);
    await writeLines(conn, 'purchase_order', cur.id, p, { replace: true });
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_order.update', entityType: 'purchase_orders', entityId: cur.public_id, ip: req.ip, meta: { from: { totalTtc: cur.total_ttc }, to: { totalTtc: p.calc.totalTtc } } });
  });
  res.json({ data: await orderDto(pool, req.auth.companyId, req.params.id) });
}));

router.post('/:id/confirm', requirePermission('purchase.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findPurchaseDoc(conn, 'purchase_orders', req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'INVALID_TRANSITION', 'Seule une commande brouillon peut être confirmée');
    const [[sup]] = await conn.query('SELECT * FROM suppliers WHERE id = ?', [cur.supplier_id]);
    await conn.query("UPDATE purchase_orders SET status = 'confirmed', supplier_snapshot = ?, company_snapshot = ? WHERE id = ?", [JSON.stringify(clientSnapshot(sup)), JSON.stringify(await companySnapshot(conn, req.auth.companyId)), cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_order.confirm', entityType: 'purchase_orders', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number } });
  });
  res.json({ data: await orderDto(pool, req.auth.companyId, req.params.id) });
}));

router.post('/:id/cancel', requirePermission('purchase.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findPurchaseDoc(conn, 'purchase_orders', req.auth.companyId, req.params.id, { forUpdate: true });
    if (!['draft', 'confirmed'].includes(cur.status)) throw new HttpError(409, 'INVALID_TRANSITION', 'Cette commande est déjà annulée');
    const [[n]] = await conn.query("SELECT COUNT(*) AS n FROM purchase_receipts WHERE order_id = ? AND status <> 'cancelled'", [cur.id]);
    if (n.n) throw new HttpError(409, 'HAS_RECEIPTS', 'Des réceptions existent : annulez-les d\'abord');
    if ((await activeInvoices(conn, cur.id)).length) throw new HttpError(409, 'HAS_INVOICES', 'Des factures d\'achat existent pour cette commande : annulez-les ou supprimez les brouillons d\'abord');
    await conn.query("UPDATE purchase_orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [req.body.reason, cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_order.cancel', entityType: 'purchase_orders', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number, reason: req.body.reason } });
  });
  res.json({ data: await orderDto(pool, req.auth.companyId, req.params.id) });
}));

router.delete('/:id', requirePermission('purchase.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findPurchaseDoc(conn, 'purchase_orders', req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Seule une commande brouillon peut être supprimée ; une commande confirmée s\'annule');
    await conn.query('DELETE FROM purchase_orders WHERE id = ?', [cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_order.delete', entityType: 'purchase_orders', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number } });
  });
  res.status(204).end();
}));

export default router;
