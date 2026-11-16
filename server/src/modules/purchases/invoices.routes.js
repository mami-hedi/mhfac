// Factures d'achat (kind = invoice) et avoirs fournisseur (kind = credit_note) : saisie du document du fournisseur,
// enregistrement (numéro interne, figé), règlements (supplier-payments), annulation encadrée.
// Aucune écriture de stock ici : le stock entre par les réceptions (ou les bons d'entrée).
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
import { computeDocument, addMoney, cmpMoney, subMoney, toScaled } from '../../core/calc.js';
import { listQuerySchema, escapeLike, orderBy, EXPORT_MAX } from '../../core/list.js';
import { advancedShape, applyAdvanced, csvDate, csvMoney, meta as listMeta, sendCsv } from '../../core/list-filters.js';
import { toCsv } from '../../core/csv.js';
import { addDays, bodyBase, qtySchema, clientSnapshot, companySnapshot, history, idParam, lineDto, loadLines, todayTunis, writeLines } from '../sales/common.js';
import { findPurchaseDoc, partyDto, preparePurchase, purchaseBase, purchaseHeader, receiptUnitCost, supplierName, taxIdByRate } from './common.js';
import { ensureDefaultWarehouse, findWarehouse, moveStock, reverseSource } from '../stock/stock.service.js';
import { createReceiptFromInvoice, receiptState } from './invoice-logistics.js';

const KINDS = {
  invoice: { prefix: 'FA', docType: 'purchase_invoice', label: 'Facture d\'achat' },
  credit_note: { prefix: 'AVF', docType: 'purchase_credit_note', label: 'Avoir fournisseur' },
};
const isoDate = bodyBase.issueDate;
const ref = z.string().trim().min(1, 'N° du document fournisseur requis').max(60);
// stockEntry : à l'enregistrement, les articles suivis en stock entrent en stock (facture saisie sans commande ni réception).
export const stockOpts = { stockEntry: z.boolean().optional(), warehouseId: z.string().uuid().optional() };
const invoiceBody = z.object({ ...purchaseBase, supplierRef: ref, dueDate: isoDate.optional(), ...stockOpts });

// Champs de l'option « entrer en stock » ; interdite sur une facture issue d'une commande ou d'une réception (le stock y entre par la réception : double comptage).
async function stockFields(conn, auth, body, { orderId = null, receiptId = null } = {}) {
  if (!body.stockEntry) return { stock_entry: 0, stock_warehouse_id: null };
  if (orderId || receiptId) throw new HttpError(422, 'STOCK_ENTRY_NOT_ALLOWED', 'Cette facture provient d\'une commande ou d\'une réception : le stock y entre par le bon de réception (évite un double comptage)');
  const wh = body.warehouseId ? (await findWarehouse(conn, auth.companyId, body.warehouseId)).id : null;
  return { stock_entry: 1, stock_warehouse_id: wh };
}
const money = (v) => (v ?? '0.000');

const CREDITED = "(SELECT COALESCE(SUM(cn.net_payable),0) FROM purchase_invoices cn WHERE cn.credited_invoice_id = d.id AND cn.kind = 'credit_note' AND cn.status = 'recorded')";
const BASE_SELECT = `SELECT d.*, DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS issue_date_s, DATE_FORMAT(d.due_date,'%Y-%m-%d') AS due_date_s, s.public_id AS supplier_pid, ${CREDITED} AS credited_total`;

function balanceOf(r) {
  const credited = money(r.credited_total);
  const due = subMoney(subMoney(r.net_payable, r.paid_amount), credited);
  return { credited, balance: cmpMoney(due, '0') < 0 ? '0.000' : due };
}
function paymentState(r) {
  if (r.kind !== 'invoice' || r.status !== 'recorded') return { paymentStatus: null, overdue: false, ...balanceOf(r) };
  const b = balanceOf(r);
  const paid = cmpMoney(b.balance, '0') === 0;
  const paymentStatus = paid ? (cmpMoney(r.paid_amount, '0') === 0 ? 'credited' : 'paid') : cmpMoney(r.paid_amount, '0') > 0 ? 'partial' : 'unpaid';
  return { paymentStatus, overdue: !paid && r.due_date_s < todayTunis(), ...b };
}
const summary = (r) => ({
  id: r.public_id, kind: r.kind, number: r.number, supplierRef: r.supplier_ref, status: r.status, ...paymentState(r), supplierId: r.supplier_pid, supplierName: supplierName(r),
  issueDate: r.issue_date_s, dueDate: r.due_date_s, currency: r.currency, totalHt: r.total_ht, totalTtc: r.total_ttc, netPayable: r.net_payable, paidAmount: r.paid_amount,
});

// un même n° de document fournisseur ne s'enregistre qu'une fois par fournisseur (hors documents annulés)
async function assertUniqueRef(conn, companyId, supplierId, kind, supplierRef, excludeId = 0) {
  const [[d]] = await conn.query("SELECT COUNT(*) AS n FROM purchase_invoices WHERE company_id = ? AND supplier_id = ? AND kind = ? AND supplier_ref = ? AND status <> 'cancelled' AND id <> ?", [companyId, supplierId, kind, supplierRef, excludeId]);
  if (d.n) throw new HttpError(409, 'DUPLICATE_SUPPLIER_REF', `Le document « ${supplierRef} » de ce fournisseur est déjà enregistré`);
}

export async function insertPurchaseInvoice(conn, auth, body, extra = {}, { ip, meta = {} } = {}) {
  const p = await preparePurchase(conn, auth, body);
  const due = body.dueDate ?? addDays(body.issueDate, p.paymentTermsDays);
  if (due < body.issueDate) throw new HttpError(422, 'INVALID_DATE', 'L\'échéance précède la date de la facture');
  await assertUniqueRef(conn, auth.companyId, p.client.id, 'invoice', body.supplierRef);
  const publicId = newPublicId();
  const stock = await stockFields(conn, auth, body, { orderId: extra.order_id, receiptId: extra.receipt_id });
  let h = { ...purchaseHeader(p, body), public_id: publicId, company_id: auth.companyId, kind: 'invoice', status: 'draft', supplier_ref: body.supplierRef, due_date: due, created_by: auth.userId, ...stock, ...extra };
  const [r] = await conn.query(`INSERT INTO purchase_invoices (${Object.keys(h).join(',')}) VALUES (${Object.keys(h).map(() => '?').join(',')})`, Object.values(h));
  await writeLines(conn, 'purchase_invoice', r.insertId, p);
  await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'purchase_invoice.create', entityType: 'purchase_invoices', entityId: publicId, ip, meta: { supplierRef: body.supplierRef, totalTtc: p.calc.totalTtc, ...meta } });
  return { publicId, id: r.insertId };
}

export function makeRouter(kind) {
  const K = KINDS[kind];
  const router = Router();
  router.use(authenticate);
  const perm = 'purchase';

  async function fullDto(conn, companyId, publicId) {
    const [[row]] = await conn.query(`${BASE_SELECT} FROM purchase_invoices d JOIN suppliers s ON s.id = d.supplier_id WHERE d.company_id = ? AND d.public_id = ? AND d.kind = ?`, [companyId, publicId, kind]);
    if (!row) throw new HttpError(404, 'NOT_FOUND', `${K.label} introuvable`);
    const { lines, taxes } = await loadLines(conn, 'purchase_invoice', row.id);
    const base = partyDto({ ...row, issue_date_s: row.issue_date_s });
    const dto = { ...summary(row), ...base, dueDate: row.due_date_s, supplierRef: row.supplier_ref, lines: lines.map((l) => ({ ...lineDto(l), sourceLineId: l.source_line_id })), taxes: taxes.map((t) => ({ taxRate: t.tax_rate, base: t.base, amount: t.amount })), cancelReason: row.cancel_reason, recordedAt: row.recorded_at, creditReason: row.credit_reason };
    if (kind === 'invoice') { dto.stockEntry = !!row.stock_entry; if (row.stock_warehouse_id) { const [[w]] = await conn.query('SELECT public_id, name FROM warehouses WHERE id = ?', [row.stock_warehouse_id]); dto.warehouse = w ? { id: w.public_id, name: w.name } : null; }
      if (row.stock_entry && row.status !== 'draft') { const [[m]] = await conn.query("SELECT COUNT(*) AS n FROM stock_movements WHERE company_id = ? AND source_type = 'purchase_invoice' AND source_id = ? AND kind = 'entry'", [companyId, row.public_id]); dto.stockMovements = Number(m.n); } }
    if (kind === 'invoice') { const st = await receiptState(conn, row); dto.receipts = st.receipts; dto.logistics = { canGenerateReceipt: st.can, reason: st.reason }; }
    if (row.order_id) { const [[o]] = await conn.query('SELECT public_id, number FROM purchase_orders WHERE id = ?', [row.order_id]); dto.order = o ? { id: o.public_id, number: o.number } : null; }
    if (row.receipt_id) { const [[n]] = await conn.query('SELECT public_id, number FROM purchase_receipts WHERE id = ?', [row.receipt_id]); dto.receipt = n ? { id: n.public_id, number: n.number } : null; }
    if (row.credited_invoice_id) { const [[i]] = await conn.query('SELECT public_id, number, supplier_ref FROM purchase_invoices WHERE id = ?', [row.credited_invoice_id]); dto.creditedInvoice = { id: i.public_id, number: i.number, supplierRef: i.supplier_ref }; }
    if (kind === 'invoice') {
      const [used] = await conn.query("SELECT l.source_line_id, SUM(l.quantity) AS q FROM purchase_invoice_lines l JOIN purchase_invoices cn ON cn.id = l.purchase_invoice_id WHERE cn.credited_invoice_id = ? AND cn.kind = 'credit_note' AND cn.status IN ('draft','recorded') GROUP BY l.source_line_id", [row.id]);
      const usedBy = new Map(used.map((u) => [Number(u.source_line_id), toScaled(u.q, 4)]));
      dto.lines = dto.lines.map((l) => { const rem = toScaled(l.quantity, 4) - (usedBy.get(l.id) ?? 0n); return { ...l, creditableQuantity: (Number(rem) / 1e4).toFixed(4) }; });
      const [cns] = await conn.query("SELECT public_id, number, supplier_ref, status, total_ttc, net_payable FROM purchase_invoices WHERE credited_invoice_id = ? AND kind = 'credit_note' ORDER BY id", [row.id]);
      const [pays] = await conn.query("SELECT p.public_id, p.number, p.method, p.status, DATE_FORMAT(p.payment_date,'%Y-%m-%d') AS d, a.amount FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id WHERE a.invoice_id = ? ORDER BY p.payment_date, p.id", [row.id]);
      dto.payments = pays.map((p) => ({ id: p.public_id, number: p.number, method: p.method, status: p.status, date: p.d, amount: p.amount }));
      const [[rs]] = await conn.query("SELECT x.rate, x.base_amount, x.amount, DATE_FORMAT(x.withholding_date,'%Y-%m-%d') AS d, x.certificate_number, pm.public_id AS payment_pid, pm.number AS payment_number FROM document_withholdings x JOIN supplier_payments pm ON pm.id = x.payment_id AND pm.status = 'recorded' WHERE x.company_id = ? AND x.direction = 'purchase' AND x.invoice_id = ? LIMIT 1", [companyId, row.id]);
      dto.addedWithholding = rs ? { rate: rs.rate, base: rs.base_amount, amount: rs.amount, date: rs.d, certificateNumber: rs.certificate_number, paymentId: rs.payment_pid, paymentNumber: rs.payment_number } : null;
      dto.creditNotes = cns.map((c) => ({ id: c.public_id, number: c.number, supplierRef: c.supplier_ref, status: c.status, totalTtc: c.total_ttc, netPayable: c.net_payable }));
    }
    return dto;
  }
  const find = (conn, companyId, publicId, opts) => findPurchaseDoc(conn, 'purchase_invoices', companyId, publicId, opts).then((r) => {
    if (r.kind !== kind) throw new HttpError(404, 'NOT_FOUND', `${K.label} introuvable`);
    return r;
  });

  const LIST_Q = listQuerySchema.omit({ status: true }).extend({ status: z.enum(['draft', 'recorded', 'cancelled']).optional(), paymentStatus: z.enum(['unpaid', 'partial', 'paid', 'overdue']).optional(), open: z.enum(['1', 'true']).optional(), supplierId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional(), ...advancedShape });
  const listParts = (req) => {
    const q = req.query; const where = ['d.company_id = ?', 'd.kind = ?']; const params = [req.auth.companyId, kind];
    if (q.status) { where.push('d.status = ?'); params.push(q.status); }
    if (q.supplierId) { where.push('s.public_id = ?'); params.push(q.supplierId); }
    applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'd', dateCol: 'issue_date', totalCol: 'total_ttc', partyCols: ['d.number', 's.name', 'd.supplier_ref'], notesCol: 'notes', linesTable: 'purchase_invoice_lines', linesFk: 'purchase_invoice_id', hasProject: true });
    const bal = `(d.net_payable - d.paid_amount - ${CREDITED})`;
    if (q.open && kind === 'invoice') { where.push("d.status = 'recorded'"); where.push(`${bal} > 0`); }
    if (q.paymentStatus && kind === 'invoice') {
      where.push("d.status = 'recorded'");
      if (q.paymentStatus === 'paid') where.push(`${bal} <= 0`);
      else { where.push(`${bal} > 0`); if (q.paymentStatus === 'partial') where.push('d.paid_amount > 0'); if (q.paymentStatus === 'unpaid') where.push('d.paid_amount = 0'); if (q.paymentStatus === 'overdue') { where.push('d.due_date < ?'); params.push(todayTunis()); } }
    }
    return { q, where, params, from: 'FROM purchase_invoices d JOIN suppliers s ON s.id = d.supplier_id' };
  };
  const SORT = { id: 'd.id', number: 'd.number', date: 'd.issue_date', due: 'd.due_date', total: 'd.total_ttc', supplier: 's.name' };
  const order = (q) => orderBy(q.sort ?? 'date', q.order === 'asc' && !q.sort ? 'desc' : q.order, SORT, 'date'); // plus récents en haut par défaut

  router.get('/', requirePermission(`${perm}.read`), validate({ query: LIST_Q }), asyncHandler(async (req, res) => {
    const { q, where, params, from } = listParts(req);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
    const [rows] = await pool.query(`${BASE_SELECT} ${from} WHERE ${where.join(' AND ')} ORDER BY ${order(q)} LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
    res.json({ data: rows.map(summary), meta: listMeta(q, total) });
  }));

  const STATUS_FR = { draft: 'Brouillon', recorded: 'Enregistrée', cancelled: 'Annulée' }; const PAY_FR = { unpaid: 'Impayée', partial: 'Partielle', paid: 'Payée', overdue: 'En retard' };
  router.get('/export', requirePermission(`${perm}.read`), validate({ query: LIST_Q }), asyncHandler(async (req, res) => {
    const { q, where, params, from } = listParts(req);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
    const [rows] = await pool.query(`${BASE_SELECT} ${from} WHERE ${where.join(' AND ')} ORDER BY ${order(q)} LIMIT ${EXPORT_MAX}`, params);
    const list = rows.map(summary);
    await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: `purchase_${kind}.export`, entityType: 'purchase_invoices', ip: req.ip, meta: { rows: list.length, total } });
    const text = toCsv(['N° interne', 'N° fournisseur', 'Statut', 'Paiement', 'Date', 'Échéance', 'Fournisseur', 'Devise', 'Total HT', 'Total TTC', 'Net à payer', 'Réglé', 'Solde'],
      list.map((r) => [r.number ?? '', r.supplierRef ?? '', STATUS_FR[r.status] ?? r.status, PAY_FR[r.paymentStatus] ?? '', csvDate(r.issueDate), csvDate(r.dueDate), r.supplierName, r.currency, csvMoney(r.totalHt), csvMoney(r.totalTtc), csvMoney(r.netPayable), csvMoney(r.paidAmount), csvMoney(r.balance)]));
    sendCsv(res, `${kind === 'invoice' ? 'factures-achat' : 'avoirs-fournisseur'}.csv`, text, { total, shown: list.length });
  }));

  router.get('/:id', requirePermission(`${perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => { res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) }); }));
  router.get('/:id/history', requirePermission(`${perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const r = await find(pool, req.auth.companyId, req.params.id);
    res.json({ data: await history(req.auth.companyId, 'purchase_invoices', r.public_id) });
  }));

  if (kind === 'invoice') {
    const dueFor = (b, p) => {
      const due = b.dueDate ?? addDays(b.issueDate, p.paymentTermsDays);
      if (due < b.issueDate) throw new HttpError(422, 'INVALID_DATE', 'L\'échéance précède la date de la facture');
      return due;
    };
    router.post('/', requirePermission('purchase.write'), validate({ body: invoiceBody }), asyncHandler(async (req, res) => {
      let out;
      await withTransaction(async (conn) => { out = (await insertPurchaseInvoice(conn, req.auth, req.body, {}, { ip: req.ip })).publicId; });
      res.status(201).json({ data: await fullDto(pool, req.auth.companyId, out) });
    }));
    router.put('/:id', requirePermission('purchase.write'), validate({ params: idParam, body: invoiceBody }), asyncHandler(async (req, res) => {
      await withTransaction(async (conn) => {
        const cur = await find(conn, req.auth.companyId, req.params.id, { forUpdate: true });
        if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Une facture enregistrée ne peut pas être modifiée : annulez-la ou saisissez un avoir fournisseur');
        const p = await preparePurchase(conn, req.auth, req.body);
        await assertUniqueRef(conn, req.auth.companyId, p.client.id, 'invoice', req.body.supplierRef, cur.id);
        const stock = await stockFields(conn, req.auth, req.body, { orderId: cur.order_id, receiptId: cur.receipt_id });
        const h = { ...purchaseHeader(p, req.body), supplier_ref: req.body.supplierRef, due_date: dueFor(req.body, p), ...stock };
        await conn.query(`UPDATE purchase_invoices SET ${Object.keys(h).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(h), cur.id]);
        await writeLines(conn, 'purchase_invoice', cur.id, p, { replace: true });
        await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_invoice.update', entityType: 'purchase_invoices', entityId: cur.public_id, ip: req.ip, meta: { from: { totalTtc: cur.total_ttc }, to: { totalTtc: p.calc.totalTtc } } });
      });
      res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
    }));

    // Facture d'achat depuis une commande (complète) ou une réception (quantités reçues) : prix, remises et TVA de la commande.
    const fromBody = z.object({ supplierRef: ref, issueDate: isoDate.optional(), dueDate: isoDate.optional() });
    const orderBase = (o, lines, b) => ({ supplierId: o.supplier_pid, issueDate: b.issueDate ?? todayTunis(), dueDate: b.dueDate, supplierRef: b.supplierRef, currency: o.currency, exchangeRate: o.currency === 'TND' ? undefined : o.exchange_rate, rateDate: null, globalDiscountPct: String(o.global_discount_pct), paymentTermsDays: o.payment_terms_days, notes: o.notes, terms: o.terms, lines });
    const toLines = (oLines, taxId, qtyOf = (l) => l.quantity) => oLines.map((l) => ({ productId: l.product_pid ?? null, description: l.description, quantity: qtyOf(l), unit: l.unit, unitPrice: l.unit_price, discountPct: l.discount_pct, taxRateId: taxId(l.tax_rate) }));
    const loadOrder = async (conn, companyId, orderId, forUpdate = true) => {
      const [[o]] = await conn.query(`SELECT o.*, s.public_id AS supplier_pid FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ? AND o.company_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [orderId, companyId]);
      return o;
    };
    router.post('/from-order/:id', requirePermission('purchase.write'), validate({ params: idParam, body: fromBody }), asyncHandler(async (req, res) => {
      let out;
      await withTransaction(async (conn) => {
        const [[ord]] = await conn.query('SELECT id FROM purchase_orders WHERE company_id = ? AND public_id = ?', [req.auth.companyId, req.params.id]);
        if (!ord) throw new HttpError(404, 'NOT_FOUND', 'Commande introuvable');
        const o = await loadOrder(conn, req.auth.companyId, ord.id);
        if (o.status !== 'confirmed') throw new HttpError(409, 'INVALID_STATE', 'La commande doit être confirmée');
        const [act] = await conn.query("SELECT receipt_id FROM purchase_invoices WHERE order_id = ? AND kind = 'invoice' AND status <> 'cancelled'", [o.id]);
        if (act.some((a) => !a.receipt_id)) throw new HttpError(409, 'ALREADY_INVOICED', 'Cette commande est déjà facturée');
        if (act.length) throw new HttpError(409, 'INVOICED_BY_RECEIPT', 'Des factures ont été saisies depuis des réceptions : continuez par réception');
        const [oLines] = await conn.query('SELECT l.*, p.public_id AS product_pid FROM purchase_order_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.purchase_order_id = ? ORDER BY l.position', [o.id]);
        const taxId = await taxIdByRate(conn, req.auth.companyId);
        out = (await insertPurchaseInvoice(conn, req.auth, orderBase(o, toLines(oLines, taxId), req.body), { order_id: o.id }, { ip: req.ip, meta: { order: o.number } })).publicId;
      });
      res.status(201).json({ data: await fullDto(pool, req.auth.companyId, out) });
    }));
    router.post('/from-receipt/:id', requirePermission('purchase.write'), validate({ params: idParam, body: fromBody }), asyncHandler(async (req, res) => {
      let out;
      await withTransaction(async (conn) => {
        const [[rc]] = await conn.query('SELECT * FROM purchase_receipts WHERE company_id = ? AND public_id = ? FOR UPDATE', [req.auth.companyId, req.params.id]);
        if (!rc) throw new HttpError(404, 'NOT_FOUND', 'Réception introuvable');
        if (rc.status !== 'validated') throw new HttpError(409, 'INVALID_STATE', 'La réception doit être validée');
        if (!rc.order_id) throw new HttpError(409, 'SOURCE_IS_INVOICE', 'Ce bon de réception a été généré depuis une facture d\'achat : il n\'y a rien à facturer de plus');
        const o = await loadOrder(conn, req.auth.companyId, rc.order_id);
        const [[ex]] = await conn.query("SELECT COUNT(*) AS n FROM purchase_invoices WHERE receipt_id = ? AND status <> 'cancelled'", [rc.id]);
        if (ex.n) throw new HttpError(409, 'ALREADY_INVOICED', 'Cette réception est déjà facturée');
        const [[full]] = await conn.query("SELECT COUNT(*) AS n FROM purchase_invoices WHERE order_id = ? AND kind = 'invoice' AND status <> 'cancelled' AND receipt_id IS NULL", [o.id]);
        if (full.n) throw new HttpError(409, 'ORDER_INVOICED', 'La commande est déjà facturée en entier');
        const [oLines] = await conn.query('SELECT l.*, p.public_id AS product_pid FROM purchase_order_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.purchase_order_id = ? ORDER BY l.position', [o.id]);
        const [rl] = await conn.query('SELECT order_line_id, quantity FROM purchase_receipt_lines WHERE purchase_receipt_id = ?', [rc.id]);
        const qty = new Map(rl.map((l) => [Number(l.order_line_id), l.quantity]));
        const taxId = await taxIdByRate(conn, req.auth.companyId);
        const lines = toLines(oLines.filter((l) => qty.has(Number(l.id))), taxId, (l) => qty.get(Number(l.id)));
        out = (await insertPurchaseInvoice(conn, req.auth, orderBase(o, lines, req.body), { order_id: o.id, receipt_id: rc.id }, { ip: req.ip, meta: { receipt: rc.number } })).publicId;
      });
      res.status(201).json({ data: await fullDto(pool, req.auth.companyId, out) });
    }));
  } else {
    const creditBody = z.object({
      invoiceId: z.string().uuid(), supplierRef: ref, reason: z.string().trim().min(3, 'Motif requis').max(255), issueDate: isoDate.optional(),
      lines: z.array(z.object({ invoiceLineId: z.coerce.number().int().positive(), quantity: qtySchema })).min(1).max(200).optional(),
    });
    router.post('/', requirePermission('purchase.write'), validate({ body: creditBody }), asyncHandler(async (req, res) => {
      const publicId = newPublicId();
      await withTransaction(async (conn) => {
        const [[inv]] = await conn.query("SELECT * FROM purchase_invoices WHERE company_id = ? AND public_id = ? AND kind = 'invoice' FOR UPDATE", [req.auth.companyId, req.body.invoiceId]);
        if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Facture d\'achat introuvable');
        if (inv.status !== 'recorded') throw new HttpError(409, 'INVALID_STATE', 'Un avoir ne se rattache qu\'à une facture enregistrée');
        await assertUniqueRef(conn, req.auth.companyId, inv.supplier_id, 'credit_note', req.body.supplierRef);
        const { lines: invLines } = await loadLines(conn, 'purchase_invoice', inv.id);
        const [used] = await conn.query("SELECT l.source_line_id, SUM(l.quantity) AS q FROM purchase_invoice_lines l JOIN purchase_invoices cn ON cn.id = l.purchase_invoice_id WHERE cn.credited_invoice_id = ? AND cn.kind = 'credit_note' AND cn.status IN ('draft','recorded') GROUP BY l.source_line_id", [inv.id]);
        const usedBy = new Map(used.map((u) => [Number(u.source_line_id), toScaled(u.q, 4)]));
        const remaining = (l) => toScaled(l.quantity, 4) - (usedBy.get(l.id) ?? 0n);
        const wanted = req.body.lines ?? invLines.map((l) => ({ invoiceLineId: l.id, quantity: null }));
        const lines = []; const seen = new Set();
        for (const w of wanted) {
          const src = invLines.find((l) => l.id === w.invoiceLineId);
          if (!src) throw new HttpError(422, 'UNKNOWN_REFERENCE', `Ligne ${w.invoiceLineId} absente de la facture`);
          if (seen.has(src.id)) throw new HttpError(422, 'DUPLICATE_LINE', 'Ligne en double');
          seen.add(src.id);
          const rem = remaining(src); const q = w.quantity === null ? rem : toScaled(w.quantity, 4);
          if (q > rem) throw new HttpError(422, 'CREDIT_EXCEEDS_INVOICE', `Ligne ${src.position} : quantité créditée (${w.quantity}) supérieure au reste créditable`);
          if (q > 0n) lines.push({ productId: src.product_id, description: src.description, quantity: (Number(q) / 1e4).toFixed(4), unit: src.unit, unitPrice: src.unit_price, discountPct: src.discount_pct, taxRate: src.tax_rate, taxName: src.tax_name, sourceLineId: src.id });
        }
        if (!lines.length) throw new HttpError(409, 'NOTHING_TO_CREDIT', 'Cette facture est déjà entièrement créditée');
        const calc = computeDocument({ lines, globalDiscountPct: inv.global_discount_pct, stampDuty: 0, withholdingPct: inv.withholding_rate });
        const [[sum]] = await conn.query("SELECT COALESCE(SUM(total_ttc),0) AS t FROM purchase_invoices WHERE credited_invoice_id = ? AND kind = 'credit_note' AND status IN ('draft','recorded')", [inv.id]);
        if (cmpMoney(addMoney(sum.t, calc.totalTtc), inv.total_ttc) > 0) throw new HttpError(422, 'CREDIT_EXCEEDS_INVOICE', 'Le cumul des avoirs dépasse le montant de la facture');
        const issueDate = req.body.issueDate ?? todayTunis();
        const p = { calc, lines, client: { id: inv.supplier_id }, currency: inv.currency, exchangeRate: inv.exchange_rate, rateDate: inv.rate_date, withholdingPct: inv.withholding_rate, paymentTermsDays: 0, terms: null };
        const h = { ...purchaseHeader(p, { issueDate, globalDiscountPct: inv.global_discount_pct, notes: null }), supplier_snapshot: typeof inv.supplier_snapshot === 'string' ? inv.supplier_snapshot : JSON.stringify(inv.supplier_snapshot), public_id: publicId, company_id: req.auth.companyId, kind, status: 'draft', supplier_ref: req.body.supplierRef, due_date: issueDate, credited_invoice_id: inv.id, credit_reason: req.body.reason, rate_date: inv.rate_date, created_by: req.auth.userId };
        const [r] = await conn.query(`INSERT INTO purchase_invoices (${Object.keys(h).join(',')}) VALUES (${Object.keys(h).map(() => '?').join(',')})`, Object.values(h));
        await writeLines(conn, 'purchase_invoice', r.insertId, p);
        await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_credit_note.create', entityType: 'purchase_invoices', entityId: publicId, ip: req.ip, meta: { invoice: inv.number, totalTtc: calc.totalTtc, reason: req.body.reason } });
      });
      res.status(201).json({ data: await fullDto(pool, req.auth.companyId, publicId) });
    }));
  }

  router.delete('/:id', requirePermission('purchase.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await find(conn, req.auth.companyId, req.params.id, { forUpdate: true });
      if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', `Seul un brouillon peut être supprimé ; ${kind === 'invoice' ? 'une facture enregistrée s\'annule ou se corrige par un avoir' : 'un avoir enregistré est conservé'}`);
      await conn.query('DELETE FROM purchase_invoices WHERE id = ?', [cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_invoice.delete', entityType: 'purchase_invoices', entityId: cur.public_id, ip: req.ip });
    });
    res.status(204).end();
  }));

  // Enregistrement : contrôle des totaux, numéro interne continu, figeage des identités.
  router.post('/:id/record', requirePermission('purchase.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await find(conn, req.auth.companyId, req.params.id, { forUpdate: true });
      if (cur.status !== 'draft') throw new HttpError(409, 'INVALID_TRANSITION', 'Ce document est déjà enregistré ou annulé');
      if (cur.issue_date_s > todayTunis()) throw new HttpError(409, 'FUTURE_DATE', 'La date du document est dans le futur');
      const [[sup]] = await conn.query('SELECT * FROM suppliers WHERE id = ?', [cur.supplier_id]);
      const { lines } = await loadLines(conn, 'purchase_invoice', cur.id);
      if (!lines.length) throw new HttpError(422, 'EMPTY_DOCUMENT', 'Aucune ligne');
      await assertUniqueRef(conn, req.auth.companyId, cur.supplier_id, kind, cur.supplier_ref, cur.id);
      if (kind === 'credit_note') {
        const [[orig]] = await conn.query('SELECT status, total_ttc FROM purchase_invoices WHERE id = ? FOR UPDATE', [cur.credited_invoice_id]);
        if (orig.status !== 'recorded') throw new HttpError(409, 'INVALID_STATE', 'La facture d\'origine n\'est plus enregistrée');
        const [[sum]] = await conn.query("SELECT COALESCE(SUM(total_ttc),0) AS t FROM purchase_invoices WHERE credited_invoice_id = ? AND kind = 'credit_note' AND status = 'recorded'", [cur.credited_invoice_id]);
        if (cmpMoney(addMoney(sum.t, cur.total_ttc), orig.total_ttc) > 0) throw new HttpError(422, 'CREDIT_EXCEEDS_INVOICE', 'Le cumul des avoirs dépasse le montant de la facture');
      }
      const calc = computeDocument({ lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, discountPct: l.discount_pct, taxRate: l.tax_rate })), globalDiscountPct: cur.global_discount_pct, stampDuty: cur.stamp_duty, withholdingPct: cur.withholding_rate });
      if (calc.totalTtc !== cur.total_ttc || calc.netPayable !== cur.net_payable) throw new HttpError(500, 'TOTALS_MISMATCH', 'Totaux incohérents : enregistrement refusé');
      const series = todayTunis().slice(0, 4);
      const number = await nextDocNumber(conn, req.auth.companyId, K.docType, series);
      await conn.query("UPDATE purchase_invoices SET status = 'recorded', number = ?, series = ?, recorded_at = UTC_TIMESTAMP(), recorded_by = ?, supplier_snapshot = ?, company_snapshot = ? WHERE id = ?",
        [number, series, req.auth.userId, JSON.stringify(clientSnapshot(sup)), JSON.stringify(await companySnapshot(conn, req.auth.companyId)), cur.id]);
      let stockLines = 0;
      if (kind === 'invoice' && cur.stock_entry) {
        if (!req.auth.permissions.has('purchase_receipt.validate')) throw new HttpError(403, 'FORBIDDEN', 'Entrer des articles en stock exige le droit de valider une réception');
        const [tracked] = await conn.query(`SELECT l.id, l.quantity, l.net_amount, l.product_id FROM purchase_invoice_lines l JOIN products p ON p.id = l.product_id WHERE l.purchase_invoice_id = ? AND p.track_stock = 1 AND p.type = 'product' ORDER BY l.position`, [cur.id]);
        if (!tracked.length) throw new HttpError(422, 'NOTHING_TO_STOCK', 'Aucune ligne ne concerne un article suivi en stock : décochez « Entrer en stock » ou choisissez des articles');
        const whId = cur.stock_warehouse_id ?? await ensureDefaultWarehouse(conn, req.auth.companyId, req.auth.userId);
        const [[wh]] = await conn.query('SELECT status, name FROM warehouses WHERE id = ? AND company_id = ?', [whId, req.auth.companyId]);
        if (wh.status !== 'active') throw new HttpError(422, 'WAREHOUSE_ARCHIVED', `L'entrepôt « ${wh.name} » est archivé : choisissez un autre entrepôt`);
        await moveStock(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, tracked.map((t) => ({ productId: t.product_id, warehouseId: whId, kind: 'entry', quantity: String(t.quantity),
          unitCost: receiptUnitCost(cur, { net_amount: t.net_amount, quantity: t.quantity }), date: cur.issue_date_s, reason: `Facture d'achat ${number}`, source: { type: 'purchase_invoice', id: cur.public_id, number, lineId: t.id } })));
        await conn.query('UPDATE purchase_invoices SET stock_warehouse_id = ? WHERE id = ?', [whId, cur.id]);
        stockLines = tracked.length;
      }
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `purchase_${kind}.record`, entityType: 'purchase_invoices', entityId: cur.public_id, ip: req.ip, meta: { number, supplierRef: cur.supplier_ref, totalTtc: cur.total_ttc, netPayable: cur.net_payable, stockLines } });
    });
    res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
  }));

  if (kind === 'invoice') {
    router.post('/:id/receipt', requirePermission('purchase_receipt.write'), validate({ params: idParam, body: z.object({ warehouseId: z.string().uuid().optional(), receiptDate: isoDate.optional() }).default({}) }), asyncHandler(async (req, res) => {
      const receiptId = await withTransaction((conn) => createReceiptFromInvoice(conn, req.auth, req.params.id, req.body, req.ip));
      res.status(201).json({ data: { receiptId, invoice: await fullDto(pool, req.auth.companyId, req.params.id) } });
    }));
    router.post('/:id/cancel', requirePermission('purchase.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
      await withTransaction(async (conn) => {
        const cur = await find(conn, req.auth.companyId, req.params.id, { forUpdate: true });
        if (cur.status !== 'recorded') throw new HttpError(409, 'INVALID_TRANSITION', 'Seule une facture enregistrée peut être annulée');
        const [[pay]] = await conn.query("SELECT COUNT(*) AS n FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id WHERE a.invoice_id = ? AND p.status = 'recorded'", [cur.id]);
        if (pay.n || cmpMoney(cur.paid_amount, '0') > 0) throw new HttpError(409, 'HAS_PAYMENTS', 'Des règlements sont enregistrés : annulez-les d\'abord ou corrigez par un avoir');
        const [[cn]] = await conn.query("SELECT COUNT(*) AS n FROM purchase_invoices WHERE credited_invoice_id = ? AND kind = 'credit_note' AND status <> 'cancelled'", [cur.id]);
        if (cn.n > 0) throw new HttpError(409, 'HAS_CREDIT_NOTES', 'Des avoirs fournisseur existent pour cette facture');
        const [[br]] = await conn.query("SELECT COUNT(*) AS n FROM purchase_receipts WHERE source_invoice_id = ? AND status <> 'cancelled'", [cur.id]);
        if (br.n) throw new HttpError(409, 'HAS_RECEIPT', 'Un bon de réception a été généré depuis cette facture : annulez-le ou supprimez-le d\'abord');
        if (cur.stock_entry) { // l'entrée en stock est annulée par un mouvement inverse (échoue si les articles ont déjà été vendus/sortis : STOCK_INSUFFICIENT)
          await reverseSource(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, { companyId: req.auth.companyId, type: 'purchase_invoice', id: cur.public_id, number: cur.number, kinds: ['entry'], reverseKind: 'cancellation', date: todayTunis(), reason: `Annulation facture d'achat ${cur.number}` });
        }
        // la réception facturée redevient facturable ; le lien reste tracé dans l'historique
        await conn.query("UPDATE purchase_invoices SET status = 'cancelled', cancel_reason = ?, cancelled_at = UTC_TIMESTAMP(), receipt_id = NULL WHERE id = ?", [req.body.reason, cur.id]);
        await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_invoice.cancel', entityType: 'purchase_invoices', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number, supplierRef: cur.supplier_ref, reason: req.body.reason, receiptId: cur.receipt_id } });
      });
      res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
    }));
  }
  return router;
}

export const purchaseInvoicesRouter = makeRouter('invoice');
export const purchaseCreditNotesRouter = makeRouter('credit_note');
