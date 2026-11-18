// Bons de livraison : quantités uniquement (aucun montant). Brouillon -> validé (numéro BL-AAAA-NNNNN) ou annulé.
// Les quantités livrées sont suivies par ligne de commande ; un bon ne peut jamais dépasser le reste à livrer.
// La validation fait SORTIR du stock les articles suivis (module Stock, Phase 7) ; l'annulation inverse la sortie.
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
import { vehiclePlate } from '../../utils/plate.js';
import { clientSnapshot, companySnapshot, history, idParam, loadLines, qtySchema, todayTunis } from './common.js';
import { insertInvoiceDraft } from './invoices.service.js';
import { invoiceLinesFromOrder, orderInvoiceBase, qtyByLine } from './orders.routes.js';
import { ensureDefaultWarehouse, findWarehouse, moveStock, reverseSource } from '../stock/stock.service.js';
import { renderDocumentPdf } from './pdf.js';
import { attachEmailRoutes } from './email.js';

const router = Router();
router.use(authenticate);

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const noteBody = z.object({
  orderId: z.string().uuid(), warehouseId: z.string().uuid().optional(), deliveryDate: iso, vehiclePlate, deliveryAddress: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(500).nullable().optional()),
  notes: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(3000).nullable().optional()),
  lines: z.array(z.object({ orderLineId: z.coerce.number().int().positive(), quantity: qtySchema })).min(1, 'Au moins une ligne').max(200),
});
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function findNote(conn, companyId, publicId, { forUpdate = false } = {}) {
  const [[r]] = await conn.query(
    `SELECT n.*, DATE_FORMAT(n.delivery_date,'%Y-%m-%d') AS delivery_date_s, c.public_id AS client_pid, o.public_id AS order_pid, o.number AS order_number, w.public_id AS wh_pid, w.name AS wh_name, si.public_id AS src_inv_pid, si.number AS src_inv_number
     FROM delivery_notes n JOIN clients c ON c.id = n.client_id LEFT JOIN sales_orders o ON o.id = n.order_id LEFT JOIN invoices si ON si.id = n.source_invoice_id LEFT JOIN warehouses w ON w.id = n.warehouse_id WHERE n.company_id = ? AND n.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId]);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Bon de livraison introuvable');
  return r;
}

async function dto(conn, companyId, publicId) {
  const r = await findNote(conn, companyId, publicId);
  const [lines] = await conn.query('SELECT * FROM delivery_note_lines WHERE delivery_note_id = ? ORDER BY position', [r.id]);
  const [[inv]] = await conn.query("SELECT public_id, number, status FROM invoices WHERE delivery_note_id = ? AND status <> 'cancelled'", [r.id]);
  return {
    id: r.public_id, number: r.number, status: r.status, clientId: r.client_pid, clientName: parse(r.client_snapshot).name, client: parse(r.client_snapshot),
    company: r.company_snapshot ? parse(r.company_snapshot) : null, order: r.order_pid ? { id: r.order_pid, number: r.order_number } : null, sourceInvoice: r.src_inv_pid ? { id: r.src_inv_pid, number: r.src_inv_number } : null, stockImpact: !!r.stock_impact, warehouse: r.wh_pid ? { id: r.wh_pid, name: r.wh_name } : null,
    deliveryDate: r.delivery_date_s, issueDate: r.delivery_date_s, deliveryAddress: r.delivery_address, vehiclePlate: r.vehicle_plate, notes: r.notes, cancelReason: r.cancel_reason,
    lines: lines.map((l) => ({ id: l.id, orderLineId: l.order_line_id, position: l.position, description: l.description, quantity: l.quantity, unit: l.unit })),
    invoice: inv ? { id: inv.public_id, number: inv.number, status: inv.status } : null, createdAt: r.created_at,
  };
}

router.get(['/', '/export'], requirePermission('delivery.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ ...rangeShape, status: z.enum(['draft', 'validated', 'cancelled']).optional(), clientId: z.string().uuid().optional(), orderId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['n.company_id = ?']; const params = [req.auth.companyId];
  if (q.status) { where.push('n.status = ?'); params.push(q.status); }
  if (q.clientId) { where.push('c.public_id = ?'); params.push(q.clientId); }
  if (q.orderId) { where.push('o.public_id = ?'); params.push(q.orderId); }
  applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'n', dateCol: 'delivery_date', partyCols: ['n.number', 'c.name', 'o.number', 'si.number'], notesCol: 'notes', linesTable: 'delivery_note_lines', linesFk: 'delivery_note_id', orderLinesTable: 'sales_order_lines' });
  const from = 'FROM delivery_notes n JOIN clients c ON c.id = n.client_id LEFT JOIN sales_orders o ON o.id = n.order_id LEFT JOIN invoices si ON si.id = n.source_invoice_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const SORT = { id: 'n.id', number: 'n.number', date: 'n.delivery_date', client: 'c.name' };
  const [rows] = await pool.query(`SELECT n.public_id, n.number, n.status, DATE_FORMAT(n.delivery_date,'%Y-%m-%d') AS d, c.name AS client_name, c.public_id AS client_pid, o.number AS order_number, o.public_id AS order_pid, si.number AS src_inv_number, si.public_id AS src_inv_pid, n.stock_impact,
      (SELECT public_id FROM invoices i WHERE i.delivery_note_id = n.id AND i.status <> 'cancelled' LIMIT 1) AS invoice_pid
    ${from} WHERE ${where.join(' AND ')} ORDER BY ${orderBy(q.sort ?? 'date', q.order === 'asc' && !q.sort ? 'desc' : q.order, SORT, 'date')} LIMIT ? OFFSET ?`, [...params, pageOf(req).limit, pageOf(req).offset]);
  if (isExport(req)) return exportCsv(req, res, { rows, total, file: 'bons-de-livraison.csv', action: 'delivery.export', entity: 'delivery_notes', headers: ['N°', 'Statut', 'Date', 'Client', 'Commande', 'Facture source'], row: (r) => [r.number ?? '', ({ draft: 'Brouillon', validated: 'Validé', cancelled: 'Annulé' })[r.status] ?? r.status, csvDate(r.d), r.client_name, r.order_number ?? '', r.src_inv_number ?? ''] });
  res.json({ data: rows.map((r) => ({ id: r.public_id, number: r.number, status: r.status, deliveryDate: r.d, clientId: r.client_pid, clientName: r.client_name, order: r.order_pid ? { id: r.order_pid, number: r.order_number } : null, sourceInvoice: r.src_inv_pid ? { id: r.src_inv_pid, number: r.src_inv_number } : null, stockImpact: !!r.stock_impact, invoiced: !!r.invoice_pid })),
    meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
}));
router.get('/:id', requirePermission('delivery.read'), validate({ params: idParam }), asyncHandler(async (req, res) => { res.json({ data: await dto(pool, req.auth.companyId, req.params.id) }); }));
router.get('/:id/history', requirePermission('delivery.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await findNote(pool, req.auth.companyId, req.params.id);
  res.json({ data: await history(req.auth.companyId, 'delivery_notes', req.params.id) });
}));
router.get('/:id/pdf', requirePermission('delivery.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const d = await dto(pool, req.auth.companyId, req.params.id);
  const buf = await renderDocumentPdf({ kind: 'delivery_note', doc: d, companyId: req.auth.companyId, template: req.query.template, lang: req.query.lang });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileSafe(d.number ?? 'brouillon')}.pdf"` }).send(buf);
}));
attachEmailRoutes(router, {
  type: 'delivery_note', perm: 'delivery', label: 'Bon de livraison', entity: 'delivery_notes',
  fetchDoc: (conn, companyId, id) => dto(conn, companyId, id),
  render: (doc, companyId) => renderDocumentPdf({ kind: 'delivery_note', doc, companyId }),
  assertSendable: (doc) => { if (doc.status !== 'validated') throw new HttpError(409, 'INVALID_STATE', 'Seul un bon validé peut être envoyé'); },
});

// Contrôle des quantités : chaque ligne appartient à la commande, pas de doublon, quantité <= reste (hors ce bon).
async function checkLines(conn, order, body, statuses, noteId = 0) {
  const { lines: oLines } = await loadLines(conn, 'sales_order', order.id);
  const taken = await qtyByLine(conn, order.id, statuses, noteId);
  const seen = new Set(); const out = [];
  for (const [i, l] of body.lines.entries()) {
    const ol = oLines.find((x) => Number(x.id) === l.orderLineId);
    if (!ol) throw new HttpError(422, 'UNKNOWN_REFERENCE', `Ligne ${l.orderLineId} absente de la commande`);
    if (seen.has(ol.id)) throw new HttpError(422, 'DUPLICATE_LINE', 'Ligne en double');
    seen.add(ol.id);
    const q = toScaled(l.quantity, 4); const rest = toScaled(ol.quantity, 4) - (taken.get(Number(ol.id)) ?? 0n);
    if (q > rest) throw new HttpError(422, 'DELIVERY_EXCEEDS_ORDER', `Ligne ${ol.position} : quantité (${l.quantity}) supérieure au reste à livrer (${fromScaled(rest > 0n ? rest : 0n, 4)})`);
    out.push({ orderLineId: ol.id, position: i + 1, description: ol.description, quantity: l.quantity, unit: ol.unit });
  }
  return out;
}
const writeLines = async (conn, noteId, lines) => {
  await conn.query('DELETE FROM delivery_note_lines WHERE delivery_note_id = ?', [noteId]);
  for (const l of lines) await conn.query('INSERT INTO delivery_note_lines (delivery_note_id, order_line_id, position, description, quantity, unit) VALUES (?,?,?,?,?,?)', [noteId, l.orderLineId, l.position, l.description, l.quantity, l.unit]);
};
const checkDate = (d) => { if (d > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date de livraison est dans le futur'); };

router.post('/', requirePermission('delivery.write'), validate({ body: noteBody }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const [[o]] = await conn.query('SELECT * FROM sales_orders WHERE company_id = ? AND public_id = ? FOR UPDATE', [req.auth.companyId, req.body.orderId]);
    if (!o) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Commande introuvable');
    if (o.status !== 'confirmed') throw new HttpError(409, 'INVALID_STATE', 'La commande doit être confirmée pour créer un bon de livraison');
    const lines = await checkLines(conn, o, req.body, ['validated', 'draft']);
    const [[client]] = await conn.query('SELECT * FROM clients WHERE id = ?', [o.client_id]);
    const whId = req.body.warehouseId ? (await findWarehouse(conn, req.auth.companyId, req.body.warehouseId)).id : await ensureDefaultWarehouse(conn, req.auth.companyId, req.auth.userId);
    const [r] = await conn.query('INSERT INTO delivery_notes (public_id, company_id, status, order_id, warehouse_id, client_id, client_snapshot, delivery_date, delivery_address, vehicle_plate, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [publicId, req.auth.companyId, 'draft', o.id, whId, o.client_id, JSON.stringify(clientSnapshot(client)), req.body.deliveryDate, req.body.deliveryAddress ?? client.address ?? null, req.body.vehiclePlate ?? null, req.body.notes ?? null, req.auth.userId]);
    await writeLines(conn, r.insertId, lines);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'delivery.create', entityType: 'delivery_notes', entityId: publicId, ip: req.ip, meta: { order: o.number } });
  });
  res.status(201).json({ data: await dto(pool, req.auth.companyId, publicId) });
}));

router.put('/:id', requirePermission('delivery.write'), validate({ params: idParam, body: noteBody.omit({ orderId: true }).extend({ lines: noteBody.shape.lines.optional() }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findNote(conn, req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Un bon validé ne peut plus être modifié : annulez-le et recréez-le');
    if (cur.source_invoice_id) { // bon généré depuis une facture : les lignes suivent la facture, seuls la date, l'adresse, les notes et l'entrepôt se modifient
      const wh = req.body.warehouseId ? (await findWarehouse(conn, req.auth.companyId, req.body.warehouseId)).id : cur.warehouse_id;
      await conn.query('UPDATE delivery_notes SET delivery_date = ?, delivery_address = ?, vehicle_plate = ?, notes = ?, warehouse_id = ? WHERE id = ?', [req.body.deliveryDate, req.body.deliveryAddress ?? null, req.body.vehiclePlate ?? null, req.body.notes ?? null, wh, cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'delivery.update', entityType: 'delivery_notes', entityId: cur.public_id, ip: req.ip });
      return;
    }
    if (!req.body.lines) throw new HttpError(422, 'VALIDATION_ERROR', 'Au moins une ligne');
    const [[o]] = await conn.query('SELECT * FROM sales_orders WHERE id = ? FOR UPDATE', [cur.order_id]);
    const lines = await checkLines(conn, o, req.body, ['validated', 'draft'], cur.id);
    const whId = req.body.warehouseId ? (await findWarehouse(conn, req.auth.companyId, req.body.warehouseId)).id : cur.warehouse_id;
    await conn.query('UPDATE delivery_notes SET delivery_date = ?, delivery_address = ?, vehicle_plate = ?, notes = ?, warehouse_id = ? WHERE id = ?', [req.body.deliveryDate, req.body.deliveryAddress ?? null, req.body.vehiclePlate ?? null, req.body.notes ?? null, whId, cur.id]);
    await writeLines(conn, cur.id, lines);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'delivery.update', entityType: 'delivery_notes', entityId: cur.public_id, ip: req.ip });
  });
  res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
}));

router.delete('/:id', requirePermission('delivery.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findNote(conn, req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Seul un brouillon peut être supprimé ; un bon validé s\'annule');
    await conn.query('DELETE FROM delivery_notes WHERE id = ?', [cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'delivery.delete', entityType: 'delivery_notes', entityId: cur.public_id, ip: req.ip });
  });
  res.status(204).end();
}));

router.post('/:id/validate', requirePermission('delivery.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findNote(conn, req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'INVALID_TRANSITION', 'Ce bon est déjà validé ou annulé');
    checkDate(cur.delivery_date_s);
    let o = null;
    if (cur.source_invoice_id) { // BL issu d'une facture : la facture doit toujours être émise ; aucun suivi par commande
      const [[si]] = await conn.query('SELECT status FROM invoices WHERE id = ? FOR UPDATE', [cur.source_invoice_id]);
      if (si.status !== 'issued') throw new HttpError(409, 'INVALID_STATE', 'La facture source n\'est plus émise');
    } else {
      [[o]] = await conn.query('SELECT * FROM sales_orders WHERE id = ? FOR UPDATE', [cur.order_id]);
      if (o.status !== 'confirmed') throw new HttpError(409, 'INVALID_STATE', 'La commande n\'est plus confirmée');
      const [rows] = await conn.query('SELECT order_line_id, quantity FROM delivery_note_lines WHERE delivery_note_id = ?', [cur.id]);
      await checkLines(conn, o, { lines: rows.map((r) => ({ orderLineId: Number(r.order_line_id), quantity: String(r.quantity) })) }, ['validated'], cur.id);
    }
    const series = cur.delivery_date_s.slice(0, 4);
    const number = await nextDocNumber(conn, req.auth.companyId, 'delivery_note', series);
    const [[client]] = await conn.query('SELECT * FROM clients WHERE id = ?', [cur.client_id]);
    // Sortie de stock des articles suivis, dans la même transaction : tout ou rien, et jamais deux fois (verrou + unicité des mouvements).
    const whId = cur.warehouse_id ?? await ensureDefaultWarehouse(conn, req.auth.companyId, req.auth.userId);
    const [[whRow]] = await conn.query('SELECT status, name FROM warehouses WHERE id = ? AND company_id = ?', [whId, req.auth.companyId]);
    const [tracked] = cur.stock_impact ? await conn.query("SELECT dl.id, dl.quantity, COALESCE(dl.product_id, ol.product_id) AS product_id FROM delivery_note_lines dl LEFT JOIN sales_order_lines ol ON ol.id = dl.order_line_id JOIN products p ON p.id = COALESCE(dl.product_id, ol.product_id) WHERE dl.delivery_note_id = ? AND p.track_stock = 1 AND p.type = 'product' ORDER BY product_id", [cur.id]) : [[]];
    if (tracked.length && whRow.status !== 'active') throw new HttpError(422, 'WAREHOUSE_ARCHIVED', `L'entrepôt « ${whRow.name} » est archivé : choisissez un autre entrepôt`);
    if (tracked.length) await moveStock(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, tracked.map((t) => ({ productId: t.product_id, warehouseId: whId, kind: 'delivery', quantity: `-${t.quantity}`, date: cur.delivery_date_s, reason: `Livraison ${number}`, source: { type: 'delivery_note', id: cur.public_id, number, lineId: t.id } })));
    await conn.query("UPDATE delivery_notes SET warehouse_id = ?, status = 'validated', number = ?, series = ?, validated_at = UTC_TIMESTAMP(), validated_by = ?, client_snapshot = ?, company_snapshot = ? WHERE id = ?",
      [whId, number, series, req.auth.userId, JSON.stringify(clientSnapshot(client)), JSON.stringify(await companySnapshot(conn, req.auth.companyId)), cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'delivery.validate', entityType: 'delivery_notes', entityId: cur.public_id, ip: req.ip, meta: { number, order: o?.number ?? null, invoice: cur.src_inv_number ?? null, stockImpact: !!cur.stock_impact } });
  });
  res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
}));

router.post('/:id/cancel', requirePermission('delivery.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findNote(conn, req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'validated') throw new HttpError(409, 'INVALID_TRANSITION', 'Seul un bon validé peut être annulé (un brouillon se supprime)');
    const [[inv]] = await conn.query("SELECT COUNT(*) AS n FROM invoices WHERE delivery_note_id = ? AND status <> 'cancelled'", [cur.id]);
    if (inv.n) throw new HttpError(409, 'HAS_INVOICES', 'Une facture existe pour ce bon : annulez-la d\'abord');
    // les sorties de stock de cette livraison sont annulées (retour au coût de sortie d'origine)
    const [[rets]] = await conn.query("SELECT COUNT(*) AS n FROM sales_returns WHERE delivery_note_id = ? AND status IN ('draft','validated')", [cur.id]);
    if (rets.n) throw new HttpError(409, 'HAS_RETURNS', 'Des bons de retour existent pour cette livraison : annulez-les d\'abord');
    await reverseSource(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, { companyId: req.auth.companyId, type: 'delivery_note', id: cur.public_id, number: cur.number, kinds: ['delivery'], reverseKind: 'delivery_reversal', date: todayTunis(), reason: `Annulation ${cur.number}` });
    await conn.query("UPDATE delivery_notes SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [req.body.reason, cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'delivery.cancel', entityType: 'delivery_notes', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number, reason: req.body.reason } });
  });
  res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
}));

// Facture des quantités livrées (prix, remises et TVA de la commande).
router.post('/:id/invoice', requirePermission('delivery.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  if (!req.auth.permissions.has('invoice.write')) throw new HttpError(403, 'FORBIDDEN', 'Permission invoice.write requise');
  let out;
  await withTransaction(async (conn) => {
    const cur = await findNote(conn, req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'validated') throw new HttpError(409, 'INVALID_STATE', 'Le bon doit être validé');
    if (!cur.order_id) throw new HttpError(409, 'SOURCE_IS_INVOICE', 'Ce bon a été généré depuis une facture : il n\'y a rien à facturer de plus');
    const [[o]] = await conn.query('SELECT o.*, c.public_id AS client_pid FROM sales_orders o JOIN clients c ON c.id = o.client_id WHERE o.id = ? FOR UPDATE', [cur.order_id]);
    const [[ex]] = await conn.query("SELECT COUNT(*) AS n FROM invoices WHERE delivery_note_id = ? AND status <> 'cancelled'", [cur.id]);
    if (ex.n) throw new HttpError(409, 'ALREADY_INVOICED', 'Ce bon est déjà facturé');
    const [[blocking]] = await conn.query("SELECT COUNT(*) AS n FROM invoices WHERE order_id = ? AND kind = 'invoice' AND status <> 'cancelled' AND delivery_note_id IS NULL", [o.id]);
    if (blocking.n) throw new HttpError(409, 'ORDER_INVOICED', 'La commande est déjà facturée (facture complète ou acompte) : facturer par livraison n\'est plus possible');
    const [oLines] = await conn.query('SELECT l.*, p.public_id AS product_pid FROM sales_order_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.sales_order_id = ? ORDER BY l.position', [o.id]);
    const [nLines] = await conn.query('SELECT order_line_id, quantity FROM delivery_note_lines WHERE delivery_note_id = ?', [cur.id]);
    const qty = new Map(nLines.map((l) => [Number(l.order_line_id), l.quantity]));
    const used = oLines.filter((l) => qty.has(Number(l.id)));
    const [taxes] = await conn.query('SELECT public_id, rate FROM tax_rates WHERE company_id = ? AND is_active = 1 ORDER BY is_default DESC, id', [req.auth.companyId]);
    const taxId = (rate) => { const t = taxes.find((x) => Number(x.rate) === Number(rate)); if (!t) throw new HttpError(422, 'INACTIVE_TAX_RATE', `Aucun taux de TVA actif à ${Number(rate)} %`); return t.public_id; };
    const body = orderInvoiceBase({ ...o, client_pid: o.client_pid }, invoiceLinesFromOrder(used, taxId, (l) => qty.get(Number(l.id))));
    const inv = await insertInvoiceDraft(conn, req.auth, body, { order_id: o.id, delivery_note_id: cur.id }, { ip: req.ip, meta: { deliveryNote: cur.number } });
    out = inv.publicId;
  });
  res.status(201).json({ data: { invoiceId: out, deliveryNote: await dto(pool, req.auth.companyId, req.params.id) } });
}));

export default router;
