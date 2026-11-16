// Commandes client : brouillon -> confirmée (ou annulée). Livraison et facturation sont DÉRIVÉES (bons de livraison validés, factures actives).
// Facturation depuis la commande : facture complète (ou de solde si des acomptes existent), ou facture d'acompte (% de la commande).
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
import { fromScaled, toScaled, addMoney, subMoney, cmpMoney } from '../../core/calc.js';
import { listQuerySchema, escapeLike, orderBy } from '../../core/list.js';
import { applyAdvanced, rangeShape, pageOf, isExport, exportCsv, csvDate, csvMoney, parseSnap } from '../../core/list-filters.js';
import { bodyBase, clientSnapshot, commonDto, findDoc, headerValues, history, idParam, lineDto, loadLines, prepare, todayTunis, writeLines } from './common.js';
import { insertInvoiceDraft } from './invoices.service.js';
import { renderDocumentPdf } from './pdf.js';
import { attachEmailRoutes } from './email.js';

const router = Router();
router.use(authenticate);

const orderBody = z.object({ ...bodyBase, expectedDate: bodyBase.issueDate.optional().nullable() });
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// quantités livrées par ligne de commande (bons de livraison dans les statuts demandés)
export async function qtyByLine(conn, orderId, statuses, excludeNoteId = 0) {
  const [rows] = await conn.query(
    `SELECT l.order_line_id, SUM(l.quantity) AS q FROM delivery_note_lines l JOIN delivery_notes n ON n.id = l.delivery_note_id
     WHERE n.order_id = ? AND n.status IN (?) AND n.id <> ? GROUP BY l.order_line_id`, [orderId, statuses, excludeNoteId]);
  return new Map(rows.map((r) => [Number(r.order_line_id), toScaled(r.q, 4)]));
}

// Factures « actives » d'une commande (brouillon ou émise), par nature de liaison
async function activeInvoices(conn, orderId) {
  const [rows] = await conn.query(
    `SELECT id, public_id, number, status, invoice_type, delivery_note_id, deposit_pct, total_ttc, net_payable FROM invoices WHERE order_id = ? AND kind = 'invoice' AND status <> 'cancelled' ORDER BY id`, [orderId]);
  return rows;
}
const isFull = (i) => !i.delivery_note_id && i.invoice_type !== 'deposit';

function derive(order, lines, delivered, invoices) {
  const total = lines.reduce((a, l) => a + toScaled(l.quantity, 4), 0n);
  const done = lines.reduce((a, l) => a + (delivered.get(Number(l.id)) ?? 0n), 0n);
  const deliveryStatus = done === 0n ? 'none' : done >= total ? 'complete' : 'partial';
  let invoicingStatus = 'none';
  if (invoices.some(isFull)) invoicingStatus = 'invoiced';
  else if (invoices.some((i) => i.delivery_note_id)) invoicingStatus = 'partial';
  else if (invoices.some((i) => i.invoice_type === 'deposit')) invoicingStatus = 'deposit';
  return { deliveryStatus, invoicingStatus };
}

const summaryRow = (r) => ({
  id: r.public_id, number: r.number, status: r.status, clientId: r.client_pid, clientName: parse(r.client_snapshot).name, issueDate: r.issue_date_s, expectedDate: r.expected_date_s,
  currency: r.currency, totalHt: r.total_ht, totalTtc: r.total_ttc, netPayable: r.net_payable,
});

async function fullDto(conn, companyId, publicId) {
  const r = await findDoc(conn, 'sales_order', companyId, publicId);
  const { lines, taxes } = await loadLines(conn, 'sales_order', r.id);
  const delivered = await qtyByLine(conn, r.id, ['validated']);
  const reserved = await qtyByLine(conn, r.id, ['validated', 'draft']);
  const invoices = await activeInvoices(conn, r.id);
  const [notes] = await conn.query("SELECT public_id, number, status, DATE_FORMAT(delivery_date,'%Y-%m-%d') AS d FROM delivery_notes WHERE order_id = ? ORDER BY id", [r.id]);
  const [allInv] = await conn.query("SELECT public_id, number, status, invoice_type, deposit_pct, total_ttc, net_payable FROM invoices WHERE order_id = ? AND kind = 'invoice' ORDER BY id", [r.id]);
  let quote = null;
  if (r.quote_id) { const [[q]] = await conn.query('SELECT public_id, number FROM quotes WHERE id = ?', [r.quote_id]); quote = q ? { id: q.public_id, number: q.number } : null; }
  const d = derive(r, lines, delivered, invoices);
  return {
    ...summaryRow(r), ...commonDto(r), expectedDate: r.expected_date_s, cancelReason: r.cancel_reason, quote, ...d,
    lines: lines.map((l) => {
      const del = delivered.get(Number(l.id)) ?? 0n; const res = reserved.get(Number(l.id)) ?? 0n; const q = toScaled(l.quantity, 4);
      return { ...lineDto(l), deliveredQuantity: fromScaled(del, 4), remainingQuantity: fromScaled(q - del, 4), deliverableQuantity: fromScaled(q - res > 0n ? q - res : 0n, 4) };
    }),
    taxes: taxes.map((t) => ({ taxRate: t.tax_rate, base: t.base, amount: t.amount })),
    deliveryNotes: notes.map((n) => ({ id: n.public_id, number: n.number, status: n.status, date: n.d })),
    invoices: allInv.map((i) => ({ id: i.public_id, number: i.number, status: i.status, type: i.invoice_type, depositPct: i.deposit_pct, totalTtc: i.total_ttc, netPayable: i.net_payable })),
  };
}
export { fullDto as orderDto };

router.get(['/', '/export'], requirePermission('sales_order.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ ...rangeShape, status: z.enum(['draft', 'confirmed', 'cancelled']).optional(), clientId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['d.company_id = ?']; const params = [req.auth.companyId];
  if (q.status) { where.push('d.status = ?'); params.push(q.status); }
  if (q.clientId) { where.push('c.public_id = ?'); params.push(q.clientId); }
  applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'd', dateCol: 'issue_date', totalCol: 'total_ttc', partyCols: ['d.number', 'c.name'], notesCol: 'notes', linesTable: 'sales_order_lines', linesFk: 'sales_order_id', hasProject: true });
  const from = 'FROM sales_orders d JOIN clients c ON c.id = d.client_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const SORT = { id: 'd.id', number: 'd.number', date: 'd.issue_date', total: 'd.total_ttc', client: 'c.name' };
  const [rows] = await pool.query(`SELECT d.*, DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS issue_date_s, DATE_FORMAT(d.expected_date,'%Y-%m-%d') AS expected_date_s, c.public_id AS client_pid,
      (SELECT COALESCE(SUM(l.quantity),0) FROM sales_order_lines l WHERE l.sales_order_id = d.id) AS q_total,
      (SELECT COALESCE(SUM(dl.quantity),0) FROM delivery_note_lines dl JOIN delivery_notes n ON n.id = dl.delivery_note_id WHERE n.order_id = d.id AND n.status = 'validated') AS q_done,
      (SELECT COUNT(*) FROM invoices i WHERE i.order_id = d.id AND i.kind = 'invoice' AND i.status <> 'cancelled' AND i.delivery_note_id IS NULL AND i.invoice_type <> 'deposit') AS n_full,
      (SELECT COUNT(*) FROM invoices i WHERE i.order_id = d.id AND i.kind = 'invoice' AND i.status <> 'cancelled' AND i.delivery_note_id IS NOT NULL) AS n_bl,
      (SELECT COUNT(*) FROM invoices i WHERE i.order_id = d.id AND i.kind = 'invoice' AND i.status <> 'cancelled' AND i.invoice_type = 'deposit') AS n_dep
    ${from} WHERE ${where.join(' AND ')} ORDER BY ${orderBy(q.sort ?? 'date', q.order === 'asc' && !q.sort ? 'desc' : q.order, SORT, 'date')} LIMIT ? OFFSET ?`, [...params, pageOf(req).limit, pageOf(req).offset]);
  if (isExport(req)) return exportCsv(req, res, { rows, total, file: 'commandes-client.csv', action: 'sales_order.export', entity: 'sales_orders', headers: ['N°', 'Statut', 'Date', 'Livraison souhaitée', 'Client', 'Devise', 'Total HT', 'Total TTC'], row: (r) => { const x = summaryRow(r); return [x.number ?? '', ({ draft: 'Brouillon', confirmed: 'Confirmée', cancelled: 'Annulée' })[x.status] ?? x.status, csvDate(x.issueDate), csvDate(x.expectedDate), x.clientName, x.currency, csvMoney(x.totalHt), csvMoney(x.totalTtc)]; } });
  const data = rows.map((r) => ({
    ...summaryRow(r),
    deliveryStatus: Number(r.q_done) === 0 ? 'none' : Number(r.q_done) >= Number(r.q_total) ? 'complete' : 'partial',
    invoicingStatus: r.n_full ? 'invoiced' : r.n_bl ? 'partial' : r.n_dep ? 'deposit' : 'none',
  }));
  res.json({ data, meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
}));

router.get('/:id', requirePermission('sales_order.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
}));
router.get('/:id/history', requirePermission('sales_order.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await findDoc(pool, 'sales_order', req.auth.companyId, req.params.id);
  res.json({ data: await history(req.auth.companyId, 'sales_orders', req.params.id) });
}));
router.get('/:id/pdf', requirePermission('sales_order.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const dto = await fullDto(pool, req.auth.companyId, req.params.id);
  const buf = await renderDocumentPdf({ kind: 'sales_order', doc: dto, companyId: req.auth.companyId, template: req.query.template, lang: req.query.lang });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileSafe(dto.number)}.pdf"` }).send(buf);
}));
attachEmailRoutes(router, {
  type: 'sales_order', perm: 'sales_order', label: 'Bon de commande', entity: 'sales_orders',
  fetchDoc: (conn, companyId, id) => fullDto(conn, companyId, id),
  render: (doc, companyId) => renderDocumentPdf({ kind: 'sales_order', doc, companyId }),
  assertSendable: (doc) => { if (doc.status !== 'confirmed') throw new HttpError(409, 'INVALID_STATE', 'Seule une commande confirmée peut être envoyée'); },
});

const dates = (body) => {
  if (body.expectedDate && body.expectedDate < body.issueDate) throw new HttpError(422, 'INVALID_DATE', 'La date de livraison précède la date de commande');
  return body.expectedDate ?? null;
};

router.post('/', requirePermission('sales_order.write'), validate({ body: orderBody }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const p = await prepare(conn, req.auth, req.body);
    const expected = dates(req.body);
    const series = req.body.issueDate.slice(0, 4);
    const number = await nextDocNumber(conn, req.auth.companyId, 'sales_order', series);
    const h = { ...headerValues(p, req.body), public_id: publicId, company_id: req.auth.companyId, number, expected_date: expected, created_by: req.auth.userId };
    const [r] = await conn.query(`INSERT INTO sales_orders (${Object.keys(h).join(',')}) VALUES (${Object.keys(h).map(() => '?').join(',')})`, Object.values(h));
    await writeLines(conn, 'sales_order', r.insertId, p);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'sales_order.create', entityType: 'sales_orders', entityId: publicId, ip: req.ip, meta: { number, totalTtc: p.calc.totalTtc } });
  });
  res.status(201).json({ data: await fullDto(pool, req.auth.companyId, publicId) });
}));

// Devis accepté -> commande brouillon (copie exacte des lignes et montants). Le devis passe à « converti ».
router.post('/from-quote/:id', requirePermission('sales_order.write'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  if (!req.auth.permissions.has('quote.validate')) throw new HttpError(403, 'FORBIDDEN', 'Permission quote.validate requise pour convertir le devis');
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const quote = await findDoc(conn, 'quote', req.auth.companyId, req.params.id, { forUpdate: true });
    if (quote.status === 'converted') throw new HttpError(409, 'ALREADY_CONVERTED', 'Ce devis est déjà converti');
    if (quote.status !== 'accepted') throw new HttpError(409, 'INVALID_TRANSITION', 'Seul un devis accepté peut devenir une commande');
    const today = todayTunis(); const series = today.slice(0, 4);
    const number = await nextDocNumber(conn, req.auth.companyId, 'sales_order', series);
    const [r] = await conn.query(
      `INSERT INTO sales_orders (public_id, company_id, number, status, quote_id, client_id, client_snapshot, issue_date, currency, exchange_rate, rate_date, global_discount_pct, subtotal, line_discount_total, global_discount_amount,
         total_ht, total_tax, total_ttc, stamp_duty, withholding_rate, withholding_amount, net_payable, payment_terms_days, notes, terms, created_by, fodec_rate, fodec_amount)
       VALUES (?,?,?, 'draft', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [publicId, req.auth.companyId, number, quote.id, quote.client_id, typeof quote.client_snapshot === 'string' ? quote.client_snapshot : JSON.stringify(quote.client_snapshot), today, quote.currency, quote.exchange_rate, quote.rate_date, quote.global_discount_pct,
        quote.subtotal, quote.line_discount_total, quote.global_discount_amount, quote.total_ht, quote.total_tax, quote.total_ttc, quote.stamp_duty, quote.withholding_rate, quote.withholding_amount, quote.net_payable, quote.payment_terms_days, quote.notes, quote.terms, req.auth.userId, quote.fodec_rate, quote.fodec_amount]);
    await conn.query(`INSERT INTO sales_order_lines (sales_order_id, position, product_id, description, quantity, unit, unit_price, discount_pct, tax_rate, tax_name, gross_amount, discount_amount, net_amount, fodec)
      SELECT ?, position, product_id, description, quantity, unit, unit_price, discount_pct, tax_rate, tax_name, gross_amount, discount_amount, net_amount, fodec FROM quote_lines WHERE quote_id = ?`, [r.insertId, quote.id]);
    await conn.query('INSERT INTO sales_order_tax_lines (sales_order_id, tax_rate, base, amount) SELECT ?, tax_rate, base, amount FROM quote_tax_lines WHERE quote_id = ?', [r.insertId, quote.id]);
    await conn.query("UPDATE quotes SET status = 'converted', converted_order_id = ? WHERE id = ?", [r.insertId, quote.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'sales_order.create', entityType: 'sales_orders', entityId: publicId, ip: req.ip, meta: { number, fromQuote: quote.number, totalTtc: quote.total_ttc } });
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'quote.convert', entityType: 'quotes', entityId: quote.public_id, ip: req.ip, meta: { order: number } });
  });
  res.status(201).json({ data: await fullDto(pool, req.auth.companyId, publicId) });
}));

router.put('/:id', requirePermission('sales_order.write'), validate({ params: idParam, body: orderBody }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findDoc(conn, 'sales_order', req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Une commande confirmée ne peut plus être modifiée : annulez-la et recréez-la');
    const p = await prepare(conn, req.auth, req.body);
    const h = { ...headerValues(p, req.body), expected_date: dates(req.body) };
    await conn.query(`UPDATE sales_orders SET ${Object.keys(h).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(h), cur.id]);
    await writeLines(conn, 'sales_order', cur.id, p, { replace: true });
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'sales_order.update', entityType: 'sales_orders', entityId: cur.public_id, ip: req.ip, meta: { from: { totalTtc: cur.total_ttc }, to: { totalTtc: p.calc.totalTtc } } });
  });
  res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
}));

router.post('/:id/confirm', requirePermission('sales_order.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findDoc(conn, 'sales_order', req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'INVALID_TRANSITION', 'Seule une commande brouillon peut être confirmée');
    const [[client]] = await conn.query('SELECT * FROM clients WHERE id = ?', [cur.client_id]);
    const { companySnapshot } = await import('./common.js');
    await conn.query("UPDATE sales_orders SET status = 'confirmed', client_snapshot = ?, company_snapshot = ? WHERE id = ?", [JSON.stringify(clientSnapshot(client)), JSON.stringify(await companySnapshot(conn, req.auth.companyId)), cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'sales_order.confirm', entityType: 'sales_orders', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number } });
  });
  res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
}));

router.post('/:id/cancel', requirePermission('sales_order.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findDoc(conn, 'sales_order', req.auth.companyId, req.params.id, { forUpdate: true });
    if (!['draft', 'confirmed'].includes(cur.status)) throw new HttpError(409, 'INVALID_TRANSITION', 'Cette commande est déjà annulée');
    const [[n]] = await conn.query("SELECT COUNT(*) AS n FROM delivery_notes WHERE order_id = ? AND status <> 'cancelled'", [cur.id]);
    if (n.n) throw new HttpError(409, 'HAS_DELIVERIES', 'Des bons de livraison existent : annulez-les d\'abord');
    if ((await activeInvoices(conn, cur.id)).length) throw new HttpError(409, 'HAS_INVOICES', 'Des factures existent pour cette commande : annulez-les ou supprimez les brouillons d\'abord');
    await conn.query("UPDATE sales_orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [req.body.reason, cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'sales_order.cancel', entityType: 'sales_orders', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number, reason: req.body.reason } });
  });
  res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
}));

router.delete('/:id', requirePermission('sales_order.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findDoc(conn, 'sales_order', req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Seule une commande brouillon peut être supprimée ; une commande confirmée s\'annule');
    if (cur.quote_id) await conn.query("UPDATE quotes SET status = 'accepted', converted_order_id = NULL WHERE converted_order_id = ?", [cur.id]);
    await conn.query('DELETE FROM sales_orders WHERE id = ?', [cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'sales_order.delete', entityType: 'sales_orders', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number } });
  });
  res.status(204).end();
}));

// ---------- Facturation depuis la commande
async function taxIdByRate(conn, companyId) {
  const [rows] = await conn.query('SELECT public_id, rate FROM tax_rates WHERE company_id = ? AND is_active = 1 ORDER BY is_default DESC, id', [companyId]);
  return (rate) => {
    const t = rows.find((x) => Number(x.rate) === Number(rate));
    if (!t) throw new HttpError(422, 'INACTIVE_TAX_RATE', `Aucun taux de TVA actif à ${Number(rate)} % : réactivez-le avant de facturer`);
    return t.public_id;
  };
}
// lignes de commande -> lignes de facture (prix, remise, TVA identiques ; quantité éventuellement partielle)
export function invoiceLinesFromOrder(lines, taxId, qtyOf = (l) => l.quantity) {
  return lines.map((l) => ({ productId: l.product_pid ?? null, description: l.description, quantity: qtyOf(l), unit: l.unit, unitPrice: l.unit_price, discountPct: l.discount_pct, taxRateId: taxId(l.tax_rate), fodec: !!l.fodec }));
}
export const orderInvoiceBase = (order, lines, extra = {}) => ({
  clientId: order.client_pid, issueDate: todayTunis(), currency: order.currency, exchangeRate: order.currency === 'TND' ? undefined : order.exchange_rate, rateDate: null,
  globalDiscountPct: String(order.global_discount_pct), withholdingPct: String(order.withholding_rate), paymentTermsDays: order.payment_terms_days, notes: order.notes, terms: order.terms, lines, ...extra,
});

async function confirmedOrder(conn, auth, publicId) {
  const o = await findDoc(conn, 'sales_order', auth.companyId, publicId, { forUpdate: true });
  if (o.status !== 'confirmed') throw new HttpError(409, 'INVALID_STATE', 'La commande doit être confirmée');
  return o;
}

// Facture complète (ou de SOLDE : déduit les acomptes émis non encore déduits)
router.post('/:id/invoice', requirePermission('sales_order.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  if (!req.auth.permissions.has('invoice.write')) throw new HttpError(403, 'FORBIDDEN', 'Permission invoice.write requise');
  let out;
  await withTransaction(async (conn) => {
    const o = await confirmedOrder(conn, req.auth, req.params.id);
    const active = await activeInvoices(conn, o.id);
    if (active.some(isFull)) throw new HttpError(409, 'ALREADY_INVOICED', 'Cette commande est déjà facturée');
    if (active.some((i) => i.delivery_note_id)) throw new HttpError(409, 'INVOICED_BY_DELIVERY', 'Des factures ont été créées depuis des bons de livraison : continuez par livraison');
    const deposits = active.filter((i) => i.invoice_type === 'deposit');
    if (deposits.some((d) => d.status !== 'issued')) throw new HttpError(409, 'DEPOSIT_NOT_ISSUED', 'Émettez (ou supprimez) les factures d\'acompte avant de créer la facture de solde');
    const { lines } = await loadLines(conn, 'sales_order', o.id);
    const taxId = await taxIdByRate(conn, req.auth.companyId);
    const body = orderInvoiceBase(o, invoiceLinesFromOrder(lines, taxId), { applyStampDuty: Number(o.stamp_duty) > 0 });
    const deducted = deposits.reduce((a, d) => addMoney(a, d.total_ttc), '0.000');
    const type = deposits.length ? 'final' : 'standard';
    const inv = await insertInvoiceDraft(conn, req.auth, body, { order_id: o.id, invoice_type: type, deposit_deducted: deducted }, { ip: req.ip, meta: { order: o.number, type } });
    if (deposits.length) {
      if (cmpMoney(deducted, inv.p.calc.netPayable) > 0) throw new HttpError(422, 'DEPOSIT_EXCEEDS_TOTAL', 'Les acomptes dépassent le net à payer de la facture de solde');
      await conn.query('UPDATE invoices SET net_payable = ? WHERE id = ?', [subMoney(inv.p.calc.netPayable, deducted), inv.id]);
      for (const d of deposits) await conn.query('INSERT INTO invoice_deposits (invoice_id, deposit_invoice_id, amount) VALUES (?,?,?)', [inv.id, d.id, d.total_ttc]);
    }
    out = inv.publicId;
  });
  res.status(201).json({ data: { invoiceId: out, order: await fullDto(pool, req.auth.companyId, req.params.id) } });
}));

// Facture d'acompte : pourcentage de la commande, une ligne par taux de TVA (base après remise globale).
router.post('/:id/deposit', requirePermission('sales_order.validate'), validate({ params: idParam, body: z.object({ pct: z.union([z.string(), z.number()]).transform((v) => String(v).replace(',', '.')).refine((s) => /^\d{1,3}(\.\d{1,2})?$/.test(s) && Number(s) > 0 && Number(s) <= 100, 'Pourcentage entre 0,01 et 100') }) }), asyncHandler(async (req, res) => {
  if (!req.auth.permissions.has('invoice.write')) throw new HttpError(403, 'FORBIDDEN', 'Permission invoice.write requise');
  let out;
  await withTransaction(async (conn) => {
    const o = await confirmedOrder(conn, req.auth, req.params.id);
    const active = await activeInvoices(conn, o.id);
    if (active.some(isFull) || active.some((i) => i.delivery_note_id)) throw new HttpError(409, 'ALREADY_INVOICED', 'Cette commande est déjà facturée : plus d\'acompte possible');
    const used = active.filter((i) => i.invoice_type === 'deposit').reduce((a, d) => a + Math.round(Number(d.deposit_pct) * 100), 0);
    const pctInt = Math.round(Number(req.body.pct) * 100);
    if (used + pctInt > 10000) throw new HttpError(422, 'DEPOSIT_EXCEEDS_ORDER', `Le cumul des acomptes dépasserait 100 % de la commande (déjà ${used / 100} %)`);
    const [taxes] = await conn.query('SELECT tax_rate, base FROM sales_order_tax_lines WHERE sales_order_id = ? ORDER BY tax_rate', [o.id]);
    const taxId = await taxIdByRate(conn, req.auth.companyId);
    const lines = taxes.map((t) => {
      const amt = (toScaled(t.base, 3) * BigInt(pctInt) + 5000n) / 10000n;
      return { amt, line: { description: `Acompte de ${Number(req.body.pct)} % — commande ${o.number} (TVA ${Number(t.tax_rate)} %)`, quantity: '1', unit: 'unité', unitPrice: fromScaled(amt, 3), discountPct: '0', taxRateId: taxId(t.tax_rate) } };
    }).filter((x) => x.amt > 0n).map((x) => x.line);
    if (!lines.length) throw new HttpError(422, 'INVALID_AMOUNT', 'Montant d\'acompte nul');
    const body = orderInvoiceBase(o, lines, { globalDiscountPct: '0', withholdingPct: '0', applyStampDuty: false });
    const inv = await insertInvoiceDraft(conn, req.auth, body, { order_id: o.id, invoice_type: 'deposit', deposit_pct: req.body.pct }, { ip: req.ip, meta: { order: o.number, type: 'deposit', pct: req.body.pct } });
    out = inv.publicId;
  });
  res.status(201).json({ data: { invoiceId: out, order: await fullDto(pool, req.auth.companyId, req.params.id) } });
}));

export default router;
