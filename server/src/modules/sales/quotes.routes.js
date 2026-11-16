import { Router } from 'express';
import { fileSafe } from '../../utils/filename.js';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { nextDocNumber } from '../../core/numbering.js';
import { listQuerySchema, escapeLike, orderBy } from '../../core/list.js';
import { applyAdvanced, rangeShape, pageOf, isExport, exportCsv, csvDate, csvMoney, parseSnap } from '../../core/list-filters.js';
import { addDays, bodyBase, commonDto, findDoc, headerValues, history, idParam, lineDto, loadLines, loadCompany, prepare, todayTunis, writeLines } from './common.js';
import { createInvoiceDraft } from './invoices.service.js';
import { renderDocumentPdf } from './pdf.js';
import { attachEmailRoutes } from './email.js';

const router = Router();
router.use(authenticate);

const quoteBody = z.object({ ...bodyBase, validUntil: bodyBase.issueDate.optional() });
const effectiveStatus = (r) => (['draft', 'sent'].includes(r.status) && r.valid_until_s < todayTunis() ? 'expired' : r.status);
const summary = (r) => ({ id: r.public_id, number: r.number, status: effectiveStatus(r), storedStatus: r.status, clientId: r.client_pid, clientName: JSON.parse(typeof r.client_snapshot === 'string' ? r.client_snapshot : JSON.stringify(r.client_snapshot)).name, issueDate: r.issue_date_s, validUntil: r.valid_until_s, currency: r.currency, totalHt: r.total_ht, totalTtc: r.total_ttc, netPayable: r.net_payable, convertedInvoiceId: r.invoice_pid ?? null });

async function fullDto(conn, companyId, publicId) {
  const r = await findDoc(conn, 'quote', companyId, publicId);
  const { lines, taxes } = await loadLines(conn, 'quote', r.id);
  let invoicePid = null;
  if (r.converted_invoice_id) { const [[i]] = await conn.query('SELECT public_id, number FROM invoices WHERE id = ?', [r.converted_invoice_id]); invoicePid = i; }
  return { ...summary(r), ...commonDto(r), validUntil: r.valid_until_s, convertedInvoice: invoicePid ? { id: invoicePid.public_id, number: invoicePid.number } : null, lines: lines.map(lineDto), taxes: taxes.map((t) => ({ taxRate: t.tax_rate, base: t.base, amount: t.amount })) };
}

const EDITABLE = ['draft', 'sent'];

router.get(['/', '/export'], requirePermission('quote.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ ...rangeShape, status: z.enum(['draft', 'sent', 'accepted', 'refused', 'converted', 'expired']).optional(), clientId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['d.company_id = ?']; const params = [req.auth.companyId]; const today = todayTunis();
  if (q.status === 'expired') { where.push("d.status IN ('draft','sent') AND d.valid_until < ?"); params.push(today); }
  else if (q.status) { where.push('d.status = ?'); params.push(q.status); if (['draft', 'sent'].includes(q.status)) { where.push('d.valid_until >= ?'); params.push(today); } }
  if (q.clientId) { where.push('c.public_id = ?'); params.push(q.clientId); }
  applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'd', dateCol: 'issue_date', totalCol: 'total_ttc', partyCols: ['d.number', 'c.name'], notesCol: 'notes', linesTable: 'quote_lines', linesFk: 'quote_id', hasProject: true });
  const from = 'FROM quotes d JOIN clients c ON c.id = d.client_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const SORT = { id: 'd.id', number: 'd.number', date: 'd.issue_date', total: 'd.total_ttc', client: 'c.name' };
  const [rows] = await pool.query(`SELECT d.*, DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS issue_date_s, DATE_FORMAT(d.valid_until,'%Y-%m-%d') AS valid_until_s, c.public_id AS client_pid, (SELECT public_id FROM invoices i WHERE i.id = d.converted_invoice_id) AS invoice_pid ${from} WHERE ${where.join(' AND ')} ORDER BY ${orderBy(q.sort ?? 'date', q.order === 'asc' && !q.sort ? 'desc' : q.order, SORT, 'date')} LIMIT ? OFFSET ?`, [...params, pageOf(req).limit, pageOf(req).offset]);
  if (isExport(req)) return exportCsv(req, res, { rows, total, file: 'devis.csv', action: 'quote.export', entity: 'quotes', headers: ['N°', 'Statut', 'Date', 'Validité', 'Client', 'Devise', 'Total HT', 'Total TTC'], row: (r) => { const x = summary(r); return [x.number ?? '', ({ draft: 'Brouillon', sent: 'Envoyé', accepted: 'Accepté', refused: 'Refusé', converted: 'Converti', expired: 'Expiré' })[x.status] ?? x.status, csvDate(x.issueDate), csvDate(x.validUntil), x.clientName, x.currency, csvMoney(x.totalHt), csvMoney(x.totalTtc)]; } });
  res.json({ data: rows.map(summary), meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
}));

router.get('/:id', requirePermission('quote.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
}));

router.get('/:id/history', requirePermission('quote.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await findDoc(pool, 'quote', req.auth.companyId, req.params.id);
  res.json({ data: await history(req.auth.companyId, 'quotes', req.params.id) });
}));

router.get('/:id/pdf', requirePermission('quote.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const dto = await fullDto(pool, req.auth.companyId, req.params.id);
  const buf = await renderDocumentPdf({ kind: 'quote', doc: dto, companyId: req.auth.companyId, template: req.query.template, lang: req.query.lang });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileSafe(dto.number)}.pdf"` }).send(buf);
}));

attachEmailRoutes(router, {
  type: 'quote', perm: 'quote', label: 'Devis', entity: 'quotes',
  fetchDoc: (conn, companyId, id) => fullDto(conn, companyId, id),
  render: (doc, companyId) => renderDocumentPdf({ kind: 'quote', doc, companyId }),
  assertSendable: (doc) => { if (doc.status === 'expired') throw new HttpError(409, 'QUOTE_EXPIRED', 'Devis expiré : prolongez sa validité avant de l\'envoyer'); },
  // un devis en brouillon devient « envoyé » une fois le mail parti
  afterSent: async (doc, auth, ip) => {
    if (doc.storedStatus !== 'draft') return;
    await pool.query("UPDATE quotes SET status = 'sent' WHERE company_id = ? AND public_id = ? AND status = 'draft'", [auth.companyId, doc.id]);
    await audit(null, { companyId: auth.companyId, userId: auth.userId, action: 'quote.sent', entityType: 'quotes', entityId: doc.id, ip, meta: { from: 'draft', via: 'email' } });
  },
});

function validityFor(body, p) {
  const days = p.settings.sales.quoteValidityDays;
  const validUntil = body.validUntil ?? addDays(body.issueDate, days);
  if (validUntil < body.issueDate) throw new HttpError(422, 'INVALID_DATE', 'La date de validité précède la date d\'émission');
  return validUntil;
}

router.post('/', requirePermission('quote.write'), validate({ body: quoteBody }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const p = await prepare(conn, req.auth, req.body);
    const validUntil = validityFor(req.body, p);
    const number = await nextDocNumber(conn, req.auth.companyId, 'quote', req.body.issueDate.slice(0, 4));
    const h = { ...headerValues(p, req.body), public_id: publicId, company_id: req.auth.companyId, number, valid_until: validUntil, created_by: req.auth.userId };
    const [r] = await conn.query(`INSERT INTO quotes (${Object.keys(h).join(',')}) VALUES (${Object.keys(h).map(() => '?').join(',')})`, Object.values(h));
    await writeLines(conn, 'quote', r.insertId, p);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'quote.create', entityType: 'quotes', entityId: publicId, ip: req.ip, meta: { number, totalTtc: p.calc.totalTtc } });
  });
  res.status(201).json({ data: await fullDto(pool, req.auth.companyId, publicId) });
}));

router.put('/:id', requirePermission('quote.write'), validate({ params: idParam, body: quoteBody }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findDoc(conn, 'quote', req.auth.companyId, req.params.id, { forUpdate: true });
    if (!EDITABLE.includes(cur.status)) throw new HttpError(409, 'DOCUMENT_LOCKED', cur.status === 'converted' ? 'Devis converti en facture : montants verrouillés' : 'Ce devis ne peut plus être modifié');
    const p = await prepare(conn, req.auth, req.body);
    const h = { ...headerValues(p, req.body), valid_until: validityFor(req.body, p) };
    await conn.query(`UPDATE quotes SET ${Object.keys(h).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(h), cur.id]);
    await writeLines(conn, 'quote', cur.id, p, { replace: true });
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'quote.update', entityType: 'quotes', entityId: cur.public_id, ip: req.ip, meta: { from: { totalTtc: cur.total_ttc }, to: { totalTtc: p.calc.totalTtc } } });
  });
  res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
}));

const TRANSITIONS = { draft: ['sent'], sent: ['accepted', 'refused', 'draft'] };
router.post('/:id/status', requirePermission('quote.write'), validate({ params: idParam, body: z.object({ status: z.enum(['draft', 'sent', 'accepted', 'refused']) }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findDoc(conn, 'quote', req.auth.companyId, req.params.id, { forUpdate: true });
    if (!(TRANSITIONS[cur.status] ?? []).includes(req.body.status)) throw new HttpError(409, 'INVALID_TRANSITION', `Passage de « ${cur.status} » à « ${req.body.status} » impossible`);
    if (req.body.status === 'accepted' && cur.valid_until_s < todayTunis()) throw new HttpError(409, 'QUOTE_EXPIRED', 'Devis expiré : prolongez sa validité avant de l\'accepter');
    if (req.body.status === 'sent' && cur.valid_until_s < todayTunis()) throw new HttpError(409, 'QUOTE_EXPIRED', 'Devis expiré : prolongez sa validité avant de l\'envoyer');
    await conn.query('UPDATE quotes SET status = ? WHERE id = ?', [req.body.status, cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `quote.${req.body.status}`, entityType: 'quotes', entityId: cur.public_id, ip: req.ip, meta: { from: cur.status } });
  });
  res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
}));

router.post('/:id/duplicate', requirePermission('quote.write'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const src = await findDoc(conn, 'quote', req.auth.companyId, req.params.id);
    const { lines } = await loadLines(conn, 'quote', src.id);
    const today = todayTunis();
    const companyCurrency = (await loadCompany(conn, req.auth.companyId)).currency;
    const body = {
      clientId: src.client_pid, issueDate: today, currency: src.currency, exchangeRate: src.currency === companyCurrency ? undefined : src.exchange_rate,
      globalDiscountPct: src.global_discount_pct, applyStampDuty: Number(src.stamp_duty) > 0, withholdingPct: src.withholding_rate, paymentTermsDays: src.payment_terms_days, notes: src.notes, terms: src.terms,
      lines: lines.map((l) => ({ productId: l.product_pid ?? null, description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unit_price, discountPct: l.discount_pct, taxRateId: null, fodec: !!l.fodec })),
    };
    // On recrée avec les taux figés de la source : on les retrouve par valeur dans les taux de l'entreprise, sinon refus explicite.
    const [taxes] = await conn.query('SELECT public_id, rate, is_active FROM tax_rates WHERE company_id = ?', [req.auth.companyId]);
    body.lines.forEach((l, i) => { const t = taxes.find((x) => Number(x.rate) === Number(lines[i].tax_rate) && x.is_active); if (t) l.taxRateId = t.public_id; else throw new HttpError(422, 'INACTIVE_TAX_RATE', `Ligne ${i + 1} : aucun taux actif à ${lines[i].tax_rate} % — réactivez-le pour dupliquer`); });
    const parsed = quoteBody.parse(body);
    const p = await prepare(conn, req.auth, parsed);
    const number = await nextDocNumber(conn, req.auth.companyId, 'quote', today.slice(0, 4));
    const h = { ...headerValues(p, parsed), public_id: publicId, company_id: req.auth.companyId, number, valid_until: addDays(today, p.settings.sales.quoteValidityDays), created_by: req.auth.userId };
    const [r] = await conn.query(`INSERT INTO quotes (${Object.keys(h).join(',')}) VALUES (${Object.keys(h).map(() => '?').join(',')})`, Object.values(h));
    await writeLines(conn, 'quote', r.insertId, p);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'quote.duplicate', entityType: 'quotes', entityId: publicId, ip: req.ip, meta: { from: src.number, number } });
  });
  res.status(201).json({ data: await fullDto(pool, req.auth.companyId, publicId) });
}));

// Conversion : devis accepté -> facture BROUILLON liée, sans ressaisie. Le devis est ensuite verrouillé.
router.post('/:id/convert', requirePermission('quote.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  if (!req.auth.permissions.has('invoice.write')) throw new HttpError(403, 'FORBIDDEN', 'Permission invoice.write requise pour créer la facture');
  let invoicePid;
  await withTransaction(async (conn) => {
    const cur = await findDoc(conn, 'quote', req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status === 'converted') throw new HttpError(409, 'ALREADY_CONVERTED', 'Ce devis est déjà converti en facture');
    if (cur.status !== 'accepted') throw new HttpError(409, 'INVALID_TRANSITION', 'Seul un devis accepté peut être converti');
    const { lines } = await loadLines(conn, 'quote', cur.id);
    invoicePid = await createInvoiceDraft(conn, req.auth, { quote: cur, lines }, req.ip);
    const [[inv]] = await conn.query('SELECT id FROM invoices WHERE public_id = ?', [invoicePid]);
    await conn.query("UPDATE quotes SET status = 'converted', converted_invoice_id = ? WHERE id = ?", [inv.id, cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'quote.convert', entityType: 'quotes', entityId: cur.public_id, ip: req.ip, meta: { invoice: invoicePid } });
  });
  res.status(201).json({ data: { invoiceId: invoicePid, quote: await fullDto(pool, req.auth.companyId, req.params.id) } });
}));

router.delete('/:id', requirePermission('quote.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findDoc(conn, 'quote', req.auth.companyId, req.params.id, { forUpdate: true });
    if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Seul un devis en brouillon peut être supprimé');
    await conn.query('DELETE FROM quotes WHERE id = ?', [cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'quote.delete', entityType: 'quotes', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number } });
  });
  res.status(204).end();
}));

export default router;
