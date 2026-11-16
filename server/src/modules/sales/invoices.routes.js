// Factures (kind = invoice) et avoirs (kind = credit_note) : même structure, permissions et numérotation distinctes.
import { fileSafe } from '../../utils/filename.js';
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { assertLimit } from '../../core/plan.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { nextDocNumber } from '../../core/numbering.js';
import { computeDocument, addMoney, cmpMoney, subMoney, toScaled } from '../../core/calc.js';
import { listQuerySchema, escapeLike, orderBy, EXPORT_MAX } from '../../core/list.js';
import { advancedShape, applyAdvanced, csvDate, csvMoney, meta as listMeta, sendCsv } from '../../core/list-filters.js';
import { toCsv } from '../../core/csv.js';
import { addDays, bodyBase, qtySchema, clientSnapshot, commonDto, companySnapshot, findDoc, headerValues, history, idParam, lineDto, loadLines, prepare, todayTunis, writeLines } from './common.js';
import { renderDocumentPdf } from './pdf.js';
import { attachEmailRoutes } from './email.js';
import { createDeliveryNoteFromInvoice, deliveryNoteState, issueStockExit, reverseStockExit, stockCheck, stockExitFields, stockExitOpts } from './invoice-logistics.js';

const KINDS = {
  invoice: { perm: 'invoice', prefix: 'FAC', entity: 'invoices', label: 'Facture' },
  credit_note: { perm: 'credit_note', prefix: 'AVO', entity: 'credit_notes', label: 'Avoir' },
};
const isoDate = bodyBase.issueDate;
// plafond des avoirs : total TTC de la facture, moins les acomptes déjà facturés (facture de solde)
const creditCap = (inv) => subMoney(inv.total_ttc, inv.deposit_deducted ?? '0.000');
const invoiceBody = z.object({ ...bodyBase, dueDate: isoDate.optional(), ...stockExitOpts });
const money = (v) => (v ?? '0.000');

function balanceOf(r) {
  const credited = money(r.credited_total);
  const due = subMoney(subMoney(r.net_payable, r.paid_amount), credited);
  return { credited, balance: cmpMoney(due, '0') < 0 ? '0.000' : due };
}
function paymentState(r) {
  if (r.kind !== 'invoice' || r.status !== 'issued') return { paymentStatus: null, overdue: false, ...balanceOf(r) };
  const b = balanceOf(r);
  const paid = cmpMoney(b.balance, '0') === 0;
  const paymentStatus = paid ? (cmpMoney(r.paid_amount, '0') === 0 ? 'credited' : 'paid') : cmpMoney(r.paid_amount, '0') > 0 ? 'partial' : 'unpaid';
  return { paymentStatus, overdue: !paid && r.due_date_s < todayTunis(), ...b };
}

const BASE_SELECT = `SELECT d.*, DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS issue_date_s, DATE_FORMAT(d.due_date,'%Y-%m-%d') AS due_date_s, c.public_id AS client_pid,
  (SELECT COALESCE(SUM(cn.net_payable),0) FROM invoices cn WHERE cn.credited_invoice_id = d.id AND cn.kind = 'credit_note' AND cn.status = 'issued') AS credited_total`;

const summary = (r) => {
  const snap = typeof r.client_snapshot === 'string' ? JSON.parse(r.client_snapshot) : r.client_snapshot;
  return { id: r.public_id, kind: r.kind, invoiceType: r.invoice_type, number: r.number, status: r.status, ...paymentState(r), clientId: r.client_pid, clientName: snap.name, issueDate: r.issue_date_s, dueDate: r.due_date_s, currency: r.currency, totalHt: r.total_ht, totalTtc: r.total_ttc, netPayable: r.net_payable, paidAmount: r.paid_amount };
};

export function makeRouter(kind) {
  const K = KINDS[kind];
  const router = Router();
  router.use(authenticate);
  const table = 'invoices';

  async function fullDto(conn, companyId, publicId) {
    const [[row]] = await conn.query(`${BASE_SELECT} FROM invoices d JOIN clients c ON c.id = d.client_id WHERE d.company_id = ? AND d.public_id = ? AND d.kind = ?`, [companyId, publicId, kind]);
    if (!row) throw new HttpError(404, 'NOT_FOUND', `${K.label} introuvable`);
    const { lines, taxes } = await loadLines(conn, 'invoice', row.id);
    const dto = { ...summary(row), ...commonDto(row), dueDate: row.due_date_s, lines: lines.map((l) => ({ ...lineDto(l), sourceLineId: l.source_line_id })), taxes: taxes.map((t) => ({ taxRate: t.tax_rate, base: t.base, amount: t.amount })), cancelReason: row.cancel_reason, issuedAt: row.issued_at, creditReason: row.credit_reason };
    if (row.quote_id) { const [[q]] = await conn.query('SELECT public_id, number FROM quotes WHERE id = ?', [row.quote_id]); dto.quote = q ? { id: q.public_id, number: q.number } : null; }
    if (row.credited_invoice_id) { const [[i]] = await conn.query('SELECT public_id, number FROM invoices WHERE id = ?', [row.credited_invoice_id]); dto.creditedInvoice = { id: i.public_id, number: i.number }; }
    if (kind === 'invoice') {
      dto.depositPct = row.deposit_pct; dto.depositDeducted = row.deposit_deducted;
      const [deps] = await conn.query('SELECT i.public_id, i.number, d.amount FROM invoice_deposits d JOIN invoices i ON i.id = d.deposit_invoice_id WHERE d.invoice_id = ? ORDER BY d.id', [row.id]);
      dto.deposits = deps.map((d) => ({ id: d.public_id, number: d.number, amount: d.amount }));
      if (row.order_id) { const [[o]] = await conn.query('SELECT public_id, number FROM sales_orders WHERE id = ?', [row.order_id]); dto.order = o ? { id: o.public_id, number: o.number } : null; }
      if (row.delivery_note_id) { const [[n]] = await conn.query('SELECT public_id, number FROM delivery_notes WHERE id = ?', [row.delivery_note_id]); dto.deliveryNote = n ? { id: n.public_id, number: n.number } : null; }
      dto.stockExit = !!row.stock_exit;
      if (row.stock_warehouse_id) { const [[w]] = await conn.query('SELECT public_id, name FROM warehouses WHERE id = ?', [row.stock_warehouse_id]); dto.warehouse = w ? { id: w.public_id, name: w.name } : null; }
      if (row.stock_exit && row.status !== 'draft') { const [[m]] = await conn.query("SELECT COUNT(*) AS n FROM stock_movements WHERE company_id = ? AND source_type = 'invoice' AND source_id = ? AND kind = 'delivery'", [companyId, row.public_id]); dto.stockMovements = Number(m.n); }
      const dn = await deliveryNoteState(conn, row);
      dto.deliveryNotes = dn.notes; dto.logistics = { canGenerateDeliveryNote: dn.can, reason: dn.reason };
      if (row.recurring_id) { const [[rc]] = await conn.query('SELECT public_id, name FROM recurring_invoices WHERE id = ?', [row.recurring_id]); dto.recurring = rc ? { id: rc.public_id, name: rc.name } : null; }
      const [used] = await conn.query("SELECT l.source_line_id, SUM(l.quantity) AS q FROM invoice_lines l JOIN invoices cn ON cn.id = l.invoice_id WHERE cn.credited_invoice_id = ? AND cn.kind = 'credit_note' AND cn.status IN ('draft','issued') GROUP BY l.source_line_id", [row.id]);
      const usedBy = new Map(used.map((u) => [Number(u.source_line_id), toScaled(u.q, 4)]));
      dto.lines = dto.lines.map((l) => { const rem = toScaled(l.quantity, 4) - (usedBy.get(l.id) ?? 0n); return { ...l, creditableQuantity: (Number(rem) / 1e4).toFixed(4) }; });
      const [cns] = await conn.query("SELECT public_id, number, status, total_ttc, net_payable FROM invoices WHERE credited_invoice_id = ? AND kind = 'credit_note' ORDER BY id", [row.id]);
      const [pays] = await conn.query("SELECT p.public_id, p.number, p.method, p.status, DATE_FORMAT(p.payment_date,'%Y-%m-%d') AS d, a.amount FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = ? ORDER BY p.payment_date, p.id", [row.id]);
      dto.payments = pays.map((p) => ({ id: p.public_id, number: p.number, method: p.method, status: p.status, date: p.d, amount: p.amount }));
      const [[rs]] = await conn.query("SELECT x.rate, x.base_amount, x.amount, DATE_FORMAT(x.withholding_date,'%Y-%m-%d') AS d, x.certificate_number, pm.public_id AS payment_pid, pm.number AS payment_number FROM document_withholdings x JOIN payments pm ON pm.id = x.payment_id AND pm.status = 'recorded' WHERE x.company_id = ? AND x.direction = 'sales' AND x.invoice_id = ? LIMIT 1", [companyId, row.id]);
      dto.addedWithholding = rs ? { rate: rs.rate, base: rs.base_amount, amount: rs.amount, date: rs.d, certificateNumber: rs.certificate_number, paymentId: rs.payment_pid, paymentNumber: rs.payment_number } : null;
      dto.creditNotes = cns.map((c) => ({ id: c.public_id, number: c.number, status: c.status, totalTtc: c.total_ttc, netPayable: c.net_payable }));
    }
    return dto;
  }
  const find = (conn, companyId, publicId, opts) => findDoc(conn, 'invoice', companyId, publicId, opts).then((r) => {
    if (r.kind !== kind) throw new HttpError(404, 'NOT_FOUND', `${K.label} introuvable`);
    return r;
  });

  const LIST_Q = listQuerySchema.omit({ status: true }).extend({ status: z.enum(['draft', 'issued', 'cancelled']).optional(), paymentStatus: z.enum(['unpaid', 'partial', 'paid', 'overdue']).optional(), open: z.enum(['1', 'true']).optional(), clientId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional(), ...advancedShape });
  // Filtres communs à la liste et à l'export CSV : l'export reprend EXACTEMENT ce qui est affiché à l'écran.
  const listParts = (req) => {
    const q = req.query; const where = ['d.company_id = ?', 'd.kind = ?']; const params = [req.auth.companyId, kind];
    if (q.status) { where.push('d.status = ?'); params.push(q.status); }
    if (q.clientId) { where.push('c.public_id = ?'); params.push(q.clientId); }
    applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'd', dateCol: 'issue_date', totalCol: 'total_ttc', partyCols: ['d.number', 'c.name'], notesCol: 'notes', linesTable: 'invoice_lines', linesFk: 'invoice_id', hasProject: true });
    const bal = '(d.net_payable - d.paid_amount - (SELECT COALESCE(SUM(cn.net_payable),0) FROM invoices cn WHERE cn.credited_invoice_id = d.id AND cn.kind = \'credit_note\' AND cn.status = \'issued\'))';
    if (q.open && kind === 'invoice') { where.push("d.status = 'issued'"); where.push(`${bal} > 0`); }
    if (q.paymentStatus && kind === 'invoice') {
      where.push("d.status = 'issued'");
      if (q.paymentStatus === 'paid') where.push(`${bal} <= 0`);
      else { where.push(`${bal} > 0`); if (q.paymentStatus === 'partial') where.push('d.paid_amount > 0'); if (q.paymentStatus === 'unpaid') where.push('d.paid_amount = 0'); if (q.paymentStatus === 'overdue') { where.push('d.due_date < ?'); params.push(todayTunis()); } }
    }
    return { q, where, params, from: 'FROM invoices d JOIN clients c ON c.id = d.client_id' };
  };
  const SORT = { id: 'd.id', number: 'd.number', date: 'd.issue_date', due: 'd.due_date', total: 'd.total_ttc', client: 'c.name' };
  // tri par défaut : date décroissante (les plus récents en haut), départagé par l'identifiant
  const order = (q) => orderBy(q.sort ?? 'date', q.order === 'asc' && !q.sort ? 'desc' : q.order, SORT, 'date');

  router.get('/', requirePermission(`${K.perm}.read`), validate({ query: LIST_Q }), asyncHandler(async (req, res) => {
    const { q, where, params, from } = listParts(req);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
    const [rows] = await pool.query(`${BASE_SELECT} ${from} WHERE ${where.join(' AND ')} ORDER BY ${order(q)} LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
    res.json({ data: rows.map(summary), meta: listMeta(q, total) });
  }));

  const STATUS_FR = { draft: 'Brouillon', issued: 'Émise', cancelled: 'Annulée' }; const PAY_FR = { unpaid: 'Impayée', partial: 'Partielle', paid: 'Payée', overdue: 'En retard' };
  router.get('/export', requirePermission(`${K.perm}.read`), validate({ query: LIST_Q }), asyncHandler(async (req, res) => {
    const { q, where, params, from } = listParts(req);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
    const [rows] = await pool.query(`${BASE_SELECT} ${from} WHERE ${where.join(' AND ')} ORDER BY ${order(q)} LIMIT ${EXPORT_MAX}`, params);
    const list = rows.map(summary);
    await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${kind === 'invoice' ? 'invoice' : 'credit_note'}.export`, entityType: 'invoices', ip: req.ip, meta: { rows: list.length, total } });
    const text = toCsv(['N°', 'Statut', 'Paiement', 'Date', 'Échéance', 'Client', 'Devise', 'Total HT', 'Total TTC', 'Net à payer', 'Réglé', 'Solde'],
      list.map((r) => [r.number ?? '', STATUS_FR[r.status] ?? r.status, PAY_FR[r.paymentStatus] ?? '', csvDate(r.issueDate), csvDate(r.dueDate), r.clientName, r.currency, csvMoney(r.totalHt), csvMoney(r.totalTtc), csvMoney(r.netPayable), csvMoney(r.paidAmount), csvMoney(r.balance)]));
    sendCsv(res, `${kind === 'invoice' ? 'factures' : 'avoirs'}.csv`, text, { total, shown: list.length });
  }));

  router.get('/:id', requirePermission(`${K.perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
  }));
  router.get('/:id/history', requirePermission(`${K.perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const r = await find(pool, req.auth.companyId, req.params.id);
    res.json({ data: await history(req.auth.companyId, 'invoices', r.public_id) });
  }));
  router.get('/:id/pdf', requirePermission(`${K.perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const dto = await fullDto(pool, req.auth.companyId, req.params.id);
    const buf = await renderDocumentPdf({ kind, doc: dto, companyId: req.auth.companyId, template: req.query.template, lang: req.query.lang });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileSafe(dto.number ?? 'brouillon')}.pdf"` }).send(buf);
  }));

  attachEmailRoutes(router, {
    type: kind, perm: K.perm, label: K.label, entity: 'invoices',
    fetchDoc: (conn, companyId, id) => fullDto(conn, companyId, id),
    render: (doc, companyId) => renderDocumentPdf({ kind, doc, companyId }),
    assertSendable: (doc) => { if (doc.status !== 'issued') throw new HttpError(409, 'INVALID_STATE', `Seul un document émis peut être envoyé (statut : ${doc.status})`); },
  });

  // --- Création / modification (brouillon uniquement)
  if (kind === 'invoice') {
    const dueFor = (body, p) => {
      const due = body.dueDate ?? addDays(body.issueDate, p.paymentTermsDays);
      if (due < body.issueDate) throw new HttpError(422, 'INVALID_DATE', 'L\'échéance précède la date de facture');
      return due;
    };
    router.post('/', requirePermission('invoice.write'), validate({ body: invoiceBody }), asyncHandler(async (req, res) => {
      const publicId = newPublicId();
      await withTransaction(async (conn) => {
        const p = await prepare(conn, req.auth, req.body);
        const h = { ...headerValues(p, req.body), ...await stockExitFields(conn, req.auth, req.body), public_id: publicId, company_id: req.auth.companyId, kind, status: 'draft', due_date: dueFor(req.body, p), created_by: req.auth.userId };
        const [r] = await conn.query(`INSERT INTO invoices (${Object.keys(h).join(',')}) VALUES (${Object.keys(h).map(() => '?').join(',')})`, Object.values(h));
        await writeLines(conn, 'invoice', r.insertId, p);
        await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'invoice.create', entityType: 'invoices', entityId: publicId, ip: req.ip, meta: { totalTtc: p.calc.totalTtc } });
      });
      res.status(201).json({ data: await fullDto(pool, req.auth.companyId, publicId) });
    }));

    router.put('/:id', requirePermission('invoice.write'), validate({ params: idParam, body: invoiceBody }), asyncHandler(async (req, res) => {
      await withTransaction(async (conn) => {
        const cur = await find(conn, req.auth.companyId, req.params.id, { forUpdate: true });
        if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Une facture émise ne peut pas être modifiée : annulez-la ou émettez un avoir');
        const p = await prepare(conn, req.auth, req.body);
        const h = { ...headerValues(p, req.body), ...await stockExitFields(conn, req.auth, req.body, { linked: !!(cur.order_id || cur.delivery_note_id) }), due_date: dueFor(req.body, p) };
        if (cmpMoney(cur.deposit_deducted, '0') > 0) {
          if (cmpMoney(cur.deposit_deducted, p.calc.netPayable) > 0) throw new HttpError(422, 'DEPOSIT_EXCEEDS_TOTAL', 'Les acomptes déduits dépassent le net à payer');
          h.net_payable = subMoney(p.calc.netPayable, cur.deposit_deducted);
        }
        await conn.query(`UPDATE invoices SET ${Object.keys(h).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(h), cur.id]);
        await writeLines(conn, 'invoice', cur.id, p, { replace: true });
        await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'invoice.update', entityType: 'invoices', entityId: cur.public_id, ip: req.ip, meta: { from: { totalTtc: cur.total_ttc }, to: { totalTtc: p.calc.totalTtc } } });
      });
      res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
    }));
  } else {
    const creditBody = z.object({
      invoiceId: z.string().uuid(), reason: z.string().trim().min(3, 'Motif requis').max(255), issueDate: isoDate.optional(),
      lines: z.array(z.object({ invoiceLineId: z.coerce.number().int().positive(), quantity: qtySchema })).min(1).max(200).optional(),
    });
    router.post('/', requirePermission('credit_note.write'), validate({ body: creditBody }), asyncHandler(async (req, res) => {
      const publicId = newPublicId();
      await withTransaction(async (conn) => {
        const [[inv]] = await conn.query("SELECT * FROM invoices WHERE company_id = ? AND public_id = ? AND kind = 'invoice' FOR UPDATE", [req.auth.companyId, req.body.invoiceId]);
        if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Facture introuvable');
        if (inv.status !== 'issued') throw new HttpError(409, 'INVALID_STATE', 'Un avoir ne se rattache qu\'à une facture émise');
        const [[dep]] = await conn.query('SELECT COUNT(*) AS n FROM invoice_deposits WHERE deposit_invoice_id = ?', [inv.id]);
        if (dep.n) throw new HttpError(409, 'DEPOSIT_IN_USE', 'Cet acompte est déduit d\'une facture de solde : corrigez la facture de solde');
        const { lines: invLines } = await loadLines(conn, 'invoice', inv.id);
        const [used] = await conn.query("SELECT l.source_line_id, SUM(l.quantity) AS q FROM invoice_lines l JOIN invoices cn ON cn.id = l.invoice_id WHERE cn.credited_invoice_id = ? AND cn.kind = 'credit_note' AND cn.status IN ('draft','issued') GROUP BY l.source_line_id", [inv.id]);
        const usedBy = new Map(used.map((u) => [Number(u.source_line_id), toScaled(u.q, 4)]));
        const remaining = (l) => toScaled(l.quantity, 4) - (usedBy.get(l.id) ?? 0n);
        const wanted = req.body.lines ?? invLines.map((l) => ({ invoiceLineId: l.id, quantity: null }));
        const lines = []; const seen = new Set();
        for (const w of wanted) {
          const src = invLines.find((l) => l.id === w.invoiceLineId);
          if (!src) throw new HttpError(422, 'UNKNOWN_REFERENCE', `Ligne ${w.invoiceLineId} absente de la facture`);
          if (seen.has(src.id)) throw new HttpError(422, 'DUPLICATE_LINE', 'Ligne en double');
          seen.add(src.id);
          const rem = remaining(src);
          const q = w.quantity === null ? rem : toScaled(w.quantity, 4);
          if (q > rem) throw new HttpError(422, 'CREDIT_EXCEEDS_INVOICE', `Ligne ${src.position} : quantité créditée (${w.quantity}) supérieure au reste créditable`);
          if (q > 0n) lines.push({ productId: src.product_id, description: src.description, quantity: (Number(q) / 1e4).toFixed(4), unit: src.unit, unitPrice: src.unit_price, discountPct: src.discount_pct, taxRate: src.tax_rate, taxName: src.tax_name, sourceLineId: src.id, fodec: !!src.fodec });
        }
        if (!lines.length) throw new HttpError(409, 'NOTHING_TO_CREDIT', 'Cette facture est déjà entièrement créditée');
        const calc = computeDocument({ lines, globalDiscountPct: inv.global_discount_pct, stampDuty: 0, withholdingPct: inv.withholding_rate, fodecRate: inv.fodec_rate });
        // plafond de sécurité : cumul des avoirs <= total de la facture
        const [[sum]] = await conn.query("SELECT COALESCE(SUM(total_ttc),0) AS t FROM invoices WHERE credited_invoice_id = ? AND kind = 'credit_note' AND status IN ('draft','issued')", [inv.id]);
        if (cmpMoney(addMoney(sum.t, calc.totalTtc), creditCap(inv)) > 0) throw new HttpError(422, 'CREDIT_EXCEEDS_INVOICE', 'Le cumul des avoirs dépasse le montant de la facture');
        const issueDate = req.body.issueDate ?? todayTunis();
        const p = { calc, lines, client: { id: inv.client_id }, currency: inv.currency, exchangeRate: inv.exchange_rate, rateDate: inv.rate_date, withholdingPct: inv.withholding_rate, paymentTermsDays: 0, terms: null };
        const h = { ...headerValues({ ...p, client: { id: inv.client_id } }, { issueDate, globalDiscountPct: inv.global_discount_pct, notes: null }), client_snapshot: typeof inv.client_snapshot === 'string' ? inv.client_snapshot : JSON.stringify(inv.client_snapshot), public_id: publicId, company_id: req.auth.companyId, kind, status: 'draft', due_date: issueDate, credited_invoice_id: inv.id, credit_reason: req.body.reason, rate_date: inv.rate_date, created_by: req.auth.userId };
        const [r] = await conn.query(`INSERT INTO invoices (${Object.keys(h).join(',')}) VALUES (${Object.keys(h).map(() => '?').join(',')})`, Object.values(h));
        await writeLines(conn, 'invoice', r.insertId, p);
        await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'credit_note.create', entityType: 'invoices', entityId: publicId, ip: req.ip, meta: { invoice: inv.number, totalTtc: calc.totalTtc, reason: req.body.reason } });
      });
      res.status(201).json({ data: await fullDto(pool, req.auth.companyId, publicId) });
    }));
  }

  // --- Suppression : brouillon uniquement (un brouillon n'a pas de numéro : aucun trou de numérotation)
  router.delete('/:id', requirePermission(`${K.perm}.delete`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await find(conn, req.auth.companyId, req.params.id, { forUpdate: true });
      if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', `Seul un brouillon peut être supprimé ; ${kind === 'invoice' ? 'une facture émise s\'annule ou se corrige par un avoir' : 'un avoir émis est conservé'}`);
      const [[dep]] = kind === 'invoice' ? await conn.query('SELECT COUNT(*) AS n FROM invoice_deposits WHERE deposit_invoice_id = ?', [cur.id]) : [[{ n: 0 }]];
      if (dep.n) throw new HttpError(409, 'DEPOSIT_IN_USE', 'Cet acompte est utilisé par une facture de solde');
      await conn.query('DELETE FROM invoice_deposits WHERE invoice_id = ?', [cur.id]);
      await conn.query('DELETE FROM invoices WHERE id = ?', [cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${K.perm}.delete`, entityType: 'invoices', entityId: cur.public_id, ip: req.ip });
    });
    res.status(204).end();
  }));

  // --- Émission : contrôle des totaux, numéro, figeage de l'identité client/entreprise
  router.post('/:id/issue', requirePermission(`${K.perm}.validate`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await find(conn, req.auth.companyId, req.params.id, { forUpdate: true });
      if (cur.status !== 'draft') throw new HttpError(409, 'INVALID_TRANSITION', 'Ce document est déjà émis ou annulé');
      if (kind === 'invoice') await assertLimit(conn, req.auth.companyId, 'invoicesPerMonth'); // limite du plan (verrouille l'abonnement : pas de dépassement concurrent)
      const today = todayTunis();
      if (cur.issue_date_s > today) throw new HttpError(409, 'FUTURE_DATE', 'La date du document est dans le futur');
      if (cur.due_date_s < cur.issue_date_s) throw new HttpError(422, 'INVALID_DATE', 'L\'échéance précède la date du document');
      const [[client]] = await conn.query('SELECT * FROM clients WHERE id = ?', [cur.client_id]);
      const { lines } = await loadLines(conn, 'invoice', cur.id);
      if (!lines.length) throw new HttpError(422, 'EMPTY_DOCUMENT', 'Aucune ligne');
      if (kind === 'credit_note') {
        const [[orig]] = await conn.query('SELECT status FROM invoices WHERE id = ? FOR UPDATE', [cur.credited_invoice_id]);
        if (orig.status !== 'issued') throw new HttpError(409, 'INVALID_STATE', 'La facture d\'origine n\'est plus émise');
        const [[sum]] = await conn.query("SELECT COALESCE(SUM(total_ttc),0) AS t FROM invoices WHERE credited_invoice_id = ? AND kind = 'credit_note' AND status = 'issued'", [cur.credited_invoice_id]);
        const [[o]] = await conn.query('SELECT total_ttc, deposit_deducted FROM invoices WHERE id = ?', [cur.credited_invoice_id]);
        if (cmpMoney(addMoney(sum.t, cur.total_ttc), creditCap(o)) > 0) throw new HttpError(422, 'CREDIT_EXCEEDS_INVOICE', 'Le cumul des avoirs dépasse le montant de la facture');
      }
      // Recalcul de contrôle à partir des lignes stockées : le total enregistré doit être celui du moteur.
      const calc = computeDocument({ lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, discountPct: l.discount_pct, taxRate: l.tax_rate, fodec: !!l.fodec })), globalDiscountPct: cur.global_discount_pct, stampDuty: cur.stamp_duty, withholdingPct: cur.withholding_rate, fodecRate: cur.fodec_rate });
      if (calc.totalTtc !== cur.total_ttc || subMoney(calc.netPayable, cur.deposit_deducted) !== cur.net_payable) throw new HttpError(500, 'TOTALS_MISMATCH', 'Totaux incohérents : émission refusée');
      const series = cur.issue_date_s.slice(0, 4);
      const [[last]] = await conn.query("SELECT DATE_FORMAT(MAX(issue_date),'%Y-%m-%d') AS d FROM invoices WHERE company_id = ? AND kind = ? AND series = ? AND status <> 'draft'", [req.auth.companyId, kind, series]);
      if (last.d && cur.issue_date_s < last.d) throw new HttpError(409, 'DATE_ORDER', `La date doit être postérieure ou égale au dernier document émis (${last.d}) pour respecter l'ordre chronologique de la numérotation`);
      const number = await nextDocNumber(conn, req.auth.companyId, kind, series);
      await conn.query("UPDATE invoices SET status = 'issued', number = ?, series = ?, issued_at = UTC_TIMESTAMP(), issued_by = ?, client_snapshot = ?, company_snapshot = ? WHERE id = ?",
        [number, series, req.auth.userId, JSON.stringify(clientSnapshot(client)), JSON.stringify(await companySnapshot(conn, req.auth.companyId)), cur.id]);
      // Option « sortir du stock » : mêmes transaction et numéro que l'émission ; un stock insuffisant (si le stock négatif est interdit) annule TOUT l'émission.
      const stockLines = kind === 'invoice' && cur.stock_exit ? await issueStockExit(conn, req.auth, cur, number) : 0;
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${K.perm}.issue`, entityType: 'invoices', entityId: cur.public_id, ip: req.ip, meta: { number, totalTtc: cur.total_ttc, netPayable: cur.net_payable, stockLines } });
    });
    res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
  }));

  // --- Annulation encadrée (facture émise, sans règlement ni avoir) : le numéro est conservé
  if (kind === 'invoice') {
    router.post('/:id/cancel', requirePermission('invoice.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
      await withTransaction(async (conn) => {
        const cur = await find(conn, req.auth.companyId, req.params.id, { forUpdate: true });
        if (cur.status !== 'issued') throw new HttpError(409, 'INVALID_TRANSITION', 'Seule une facture émise peut être annulée');
        if (cmpMoney(cur.paid_amount, '0') > 0) throw new HttpError(409, 'HAS_PAYMENTS', 'Des règlements sont enregistrés : corrigez par un avoir');
        const [[ei]] = await conn.query("SELECT COUNT(*) AS n FROM einvoice_transmissions WHERE invoice_id = ? AND status IN ('transmitted','accepted')", [cur.id]);
        if (ei.n > 0) throw new HttpError(409, 'EINVOICE_TRANSMITTED', 'Cette facture a été transmise par facturation électronique : corrigez-la par un avoir');
        const [[cn]] = await conn.query("SELECT COUNT(*) AS n FROM invoices WHERE credited_invoice_id = ? AND kind = 'credit_note' AND status <> 'cancelled'", [cur.id]);
        if (cn.n > 0) throw new HttpError(409, 'HAS_CREDIT_NOTES', 'Des avoirs existent pour cette facture');
        const [[dep]] = await conn.query('SELECT COUNT(*) AS n FROM invoice_deposits WHERE deposit_invoice_id = ?', [cur.id]);
        if (dep.n) throw new HttpError(409, 'DEPOSIT_IN_USE', 'Cet acompte est déduit d\'une facture de solde : annulez d\'abord celle-ci');
        const [[bl]] = await conn.query("SELECT COUNT(*) AS n FROM delivery_notes WHERE source_invoice_id = ? AND status <> 'cancelled'", [cur.id]);
        if (bl.n > 0) throw new HttpError(409, 'HAS_DELIVERY_NOTE', 'Un bon de livraison est lié à cette facture : annulez ou supprimez-le d\'abord');
        if (cur.stock_exit) await reverseStockExit(conn, req.auth, cur); // les articles reviennent en stock par des mouvements inverses
        await conn.query('DELETE FROM invoice_deposits WHERE invoice_id = ?', [cur.id]); // les acomptes redeviennent déductibles
        // le bon de livraison facturé redevient facturable ; le lien reste tracé dans l'historique
        await conn.query("UPDATE invoices SET status = 'cancelled', cancel_reason = ?, cancelled_at = UTC_TIMESTAMP(), delivery_note_id = NULL WHERE id = ?", [req.body.reason, cur.id]);
        await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'invoice.cancel', entityType: 'invoices', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number, reason: req.body.reason, stockReversed: !!cur.stock_exit } });
      });
      res.json({ data: await fullDto(pool, req.auth.companyId, req.params.id) });
    }));

    // --- Logistique d'une facture directe : contrôle de stock indicatif et génération du bon de livraison
    router.post('/stock-check', requirePermission('invoice.write'), validate({ body: z.object({ warehouseId: z.string().uuid().optional(), lines: z.array(z.object({ productId: z.string().uuid(), quantity: qtySchema })).min(1).max(200) }).strict() }), asyncHandler(async (req, res) => {
      res.json({ data: await stockCheck(pool, req.auth, req.body) });
    }));
    router.post('/:id/delivery-note', requirePermission('delivery.write'), validate({ params: idParam, body: z.object({ warehouseId: z.string().uuid().optional(), deliveryDate: isoDate.optional() }).strict() }), asyncHandler(async (req, res) => {
      if (!req.auth.permissions.has('invoice.read')) throw new HttpError(403, 'FORBIDDEN', 'Permission invoice.read requise');
      let noteId;
      await withTransaction(async (conn) => { noteId = await createDeliveryNoteFromInvoice(conn, req.auth, req.params.id, req.body, req.ip); });
      res.status(201).json({ data: { deliveryNoteId: noteId, invoice: await fullDto(pool, req.auth.companyId, req.params.id) } });
    }));
  }
  return router;
}

export const invoicesRouter = makeRouter('invoice');
export const creditNotesRouter = makeRouter('credit_note');
