// Règlements clients ET fournisseurs (même logique, tables différentes).
// - Un règlement est affecté à une ou plusieurs factures ; paid_amount des factures est recalculé depuis les affectations sous verrou.
// - Trop-perçu : le montant reçu/versé peut dépasser les affectations ; le reste (non affecté) est une AVANCE affectable plus tard.
// - Trésorerie : un compte peut être choisi (écriture immédiate) ; chèques et effets créent un instrument suivi jusqu'à l'encaissement.
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
import { addMoney, cmpMoney, subMoney, toScaled, fromScaled, money } from '../../core/calc.js';
import { listQuerySchema, escapeLike, orderBy } from '../../core/list.js';
import { advancedShape, applyAdvanced, rangeShape, pageOf, isExport, exportCsv, csvDate, csvMoney, parseSnap } from '../../core/list-filters.js';
import { history, idParam, todayTunis } from '../sales/common.js';
import { linkPayment, unlinkPayment } from '../treasury/treasury.service.js';

export const METHODS = { cash: 'Espèces', cheque: 'Chèque', bank_transfer: 'Virement', card: 'Carte bancaire', bill_of_exchange: 'Effet de commerce', other: 'Autre', withholding: 'Retenue à la source' };
// Modes saisissables à la main : la retenue n'est créée que par le bouton dédié (POST /withholding).
export const MANUAL_METHODS = Object.keys(METHODS).filter((m) => m !== 'withholding');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ').refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s); }, 'Date invalide');
const amount = z.union([z.string(), z.number()]).transform((v) => String(v).trim().replace(',', '.')).refine((s) => /^\d{1,12}(\.\d{1,3})?$/.test(s) && Number(s) > 0, 'Montant positif (3 décimales max)').transform((s) => money(toScaled(s, 3)));
const optText = (max) => z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(max).nullable().optional());
const allocSchema = z.array(z.object({ invoiceId: z.string().uuid(), amount })).max(100);

const CONFIGS = {
  client: {
    table: 'payments', alloc: 'payment_allocations', inv: 'invoices', party: 'clients', col: 'client_id', key: 'client', prefix: 'REG', docType: 'payment', audit: 'payment', invAudit: 'invoice.payment', invEntity: 'invoices',
    okStatus: 'issued', label: 'Client', mismatch: 'CLIENT_MISMATCH', mismatchMsg: 'n\'appartient pas à ce client', notOk: 'n\'est pas émise (ou est annulée)', treasuryType: 'client_payment',
  },
  supplier: {
    table: 'supplier_payments', alloc: 'supplier_payment_allocations', inv: 'purchase_invoices', party: 'suppliers', col: 'supplier_id', key: 'supplier', prefix: 'RGF', docType: 'supplier_payment', audit: 'supplier_payment', invAudit: 'purchase_invoice.payment', invEntity: 'purchase_invoices',
    okStatus: 'recorded', label: 'Fournisseur', mismatch: 'SUPPLIER_MISMATCH', mismatchMsg: 'n\'appartient pas à ce fournisseur', notOk: 'n\'est pas enregistrée (ou est annulée)', treasuryType: 'supplier_payment',
  },
};

export function paymentsFactory(kind) {
  const C = CONFIGS[kind];
  const CREDITED = `(SELECT COALESCE(SUM(cn.net_payable),0) FROM ${C.inv} cn WHERE cn.credited_invoice_id = i.id AND cn.kind = 'credit_note' AND cn.status = '${C.okStatus}')`;
  const partyIdKey = `${C.key}Id`; const partyNameKey = `${C.key}Name`;

  const createBody = z.object({
    [partyIdKey]: z.string().uuid(), date: isoDate, method: z.enum(MANUAL_METHODS),
    amount: amount.optional(), currency: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{3}$/).optional()),
    accountId: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable().optional()), dueDate: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().optional()), bankName: optText(120),
    reference: optText(120), notes: optText(500), allocations: allocSchema,
  }).refine((b) => b.allocations.length > 0 || b.amount, { message: 'Indiquez le montant ou affectez le règlement à une facture', path: ['allocations'] });

  // Recalcule paid_amount de la facture depuis les affectations de règlements non annulés.
  async function refreshPaid(conn, invoiceId) {
    const [[s]] = await conn.query(`SELECT COALESCE(SUM(a.amount),0) AS t FROM ${C.alloc} a JOIN ${C.table} p ON p.id = a.payment_id WHERE a.invoice_id = ? AND p.status = 'recorded'`, [invoiceId]);
    await conn.query(`UPDATE ${C.inv} SET paid_amount = ? WHERE id = ?`, [s.t, invoiceId]);
  }

  const dto = (p, allocations = [], extra = {}) => ({
    id: p.public_id, number: p.number, [partyIdKey]: p.party_pid, [partyNameKey]: p.party_name, date: p.date_s, method: p.method, methodLabel: METHODS[p.method], reference: p.reference,
    amount: p.amount, allocated: p.allocated, unallocated: subMoney(p.amount, p.allocated), currency: p.currency, notes: p.notes, status: p.status, cancelReason: p.cancel_reason, createdAt: p.created_at,
    account: p.acc_pid ? { id: p.acc_pid, name: p.acc_name } : null, allocations: allocations.map((a) => ({ invoiceId: a.invoice_pid, invoiceNumber: a.invoice_number, amount: a.amount })), ...extra,
  });
  const ALLOCATED = `(SELECT COALESCE(SUM(a.amount),0) FROM ${C.alloc} a WHERE a.payment_id = p.id)`;
  const SEL = `SELECT p.*, DATE_FORMAT(p.payment_date,'%Y-%m-%d') AS date_s, c.public_id AS party_pid, c.name AS party_name, ${ALLOCATED} AS allocated, ta.public_id AS acc_pid, ta.name AS acc_name
    FROM ${C.table} p JOIN ${C.party} c ON c.id = p.${C.col} LEFT JOIN treasury_accounts ta ON ta.id = p.account_id`;
  async function load(conn, companyId, publicId) {
    const [[p]] = await conn.query(`${SEL} WHERE p.company_id = ? AND p.public_id = ?`, [companyId, publicId]);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Règlement introuvable');
    const [al] = await conn.query(`SELECT a.amount, i.public_id AS invoice_pid, i.number AS invoice_number FROM ${C.alloc} a JOIN ${C.inv} i ON i.id = a.invoice_id WHERE a.payment_id = ? ORDER BY a.id`, [p.id]);
    const [[ins]] = await conn.query("SELECT public_id, status, DATE_FORMAT(due_date,'%Y-%m-%d') AS due FROM treasury_instruments WHERE company_id = ? AND payment_type = ? AND payment_id = ?", [companyId, C.treasuryType, p.public_id]);
    return { p, al, extra: ins ? { instrument: { id: ins.public_id, status: ins.status, dueDate: ins.due } } : {} };
  }

  // Contrôle des affectations (factures verrouillées) : même tiers, devise unique, facture ouverte, pas de dépassement du solde.
  async function checkAllocations(conn, auth, partyId, allocations, { currency: expectedCurrency = null } = {}) {
    const ids = allocations.map((a) => a.invoiceId);
    if (new Set(ids).size !== ids.length) throw new HttpError(422, 'DUPLICATE_LINE', 'Facture en double dans les affectations');
    if (!ids.length) return { invs: [], total: '0.000', currency: expectedCurrency };
    const [invs] = await conn.query(`SELECT i.*, ${CREDITED} AS credited FROM ${C.inv} i WHERE i.company_id = ? AND i.kind = 'invoice' AND i.public_id IN (?) ORDER BY i.id FOR UPDATE`, [auth.companyId, ids]);
    if (invs.length !== ids.length) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Facture introuvable');
    let total = '0.000'; let currency = expectedCurrency;
    for (const a of allocations) {
      const inv = invs.find((i) => i.public_id === a.invoiceId);
      if (inv[C.col] !== partyId) throw new HttpError(422, C.mismatch, `La facture ${inv.number} ${C.mismatchMsg}`);
      if (inv.status !== C.okStatus) throw new HttpError(409, 'INVALID_STATE', `La facture ${inv.number ?? ''} ${C.notOk}`);
      currency ??= inv.currency;
      if (inv.currency !== currency) throw new HttpError(422, 'CURRENCY_MISMATCH', 'Un règlement ne peut couvrir que des factures de la même devise');
      const due = subMoney(subMoney(inv.net_payable, inv.paid_amount), inv.credited);
      if (cmpMoney(a.amount, due) > 0) throw new HttpError(422, 'OVERPAYMENT', `Facture ${inv.number} : le montant (${a.amount}) dépasse le solde restant (${cmpMoney(due, '0') < 0 ? '0.000' : due})`);
      total = addMoney(total, a.amount);
    }
    return { invs, total, currency };
  }

  // Annulation : le règlement est conservé (statut annulé, motif) ; soldes des factures, écritures de trésorerie et instruments sont rétablis.
  async function cancelPayment(conn, auth, publicId, reason, ip) {
    const [[p]] = await conn.query(`SELECT * FROM ${C.table} WHERE company_id = ? AND public_id = ? FOR UPDATE`, [auth.companyId, publicId]);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Règlement introuvable');
    if (p.status !== 'recorded') throw new HttpError(409, 'INVALID_TRANSITION', 'Règlement déjà annulé');
    const [al] = await conn.query(`SELECT invoice_id FROM ${C.alloc} WHERE payment_id = ?`, [p.id]);
    if (al.length) await conn.query(`SELECT id FROM ${C.inv} WHERE id IN (?) ORDER BY id FOR UPDATE`, [al.map((a) => a.invoice_id)]);
    await unlinkPayment(conn, { companyId: auth.companyId, userId: auth.userId }, { type: C.treasuryType, publicId: p.public_id, reason });
    await conn.query(`UPDATE ${C.table} SET status = 'cancelled', cancel_reason = ?, cancelled_at = UTC_TIMESTAMP() WHERE id = ?`, [reason, p.id]);
    for (const a of al) await refreshPaid(conn, a.invoice_id);
    await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: `${C.audit}.cancel`, entityType: C.table, entityId: p.public_id, ip, meta: { number: p.number, reason } });
    return p;
  }

  const router = Router();
  router.use(authenticate);
  router.get('/methods', requirePermission('payment.read'), (_req, res) => res.json({ data: MANUAL_METHODS.map((code) => ({ code, label: METHODS[code] })) }));

  router.get(['/', '/export'], requirePermission('payment.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ minAmount: advancedShape.minAmount, maxAmount: advancedShape.maxAmount, status: z.enum(['recorded', 'cancelled']).optional(), [partyIdKey]: z.string().uuid().optional(), method: z.enum(Object.keys(METHODS)).optional(), unallocated: z.enum(['1', 'true']).optional(), from: isoDate.optional(), to: isoDate.optional() }) }), asyncHandler(async (req, res) => {
    const q = req.query; const where = ['p.company_id = ?']; const params = [req.auth.companyId];
    if (q.status) { where.push('p.status = ?'); params.push(q.status); }
    if (q[partyIdKey]) { where.push('c.public_id = ?'); params.push(q[partyIdKey]); }
    if (q.method) { where.push('p.method = ?'); params.push(q.method); }
    applyAdvanced({ q: { ...q, q: undefined }, where, params, auth: req.auth }, { alias: 'p', dateCol: 'payment_date', totalCol: 'amount', partyCols: [] });
    if (q.unallocated) { where.push("p.status = 'recorded'"); where.push(`p.amount > ${ALLOCATED}`); }
    if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(p.number LIKE ? OR c.name LIKE ? OR p.reference LIKE ?)'); params.push(like, like, like); }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${C.table} p JOIN ${C.party} c ON c.id = p.${C.col} WHERE ${where.join(' AND ')}`, params);
    const SORT = { id: 'p.id', number: 'p.number', date: 'p.payment_date', amount: 'p.amount', client: 'c.name', party: 'c.name' };
    const [rows] = await pool.query(`${SEL} WHERE ${where.join(' AND ')} ORDER BY ${orderBy(q.sort ?? 'date', q.order === 'asc' && !q.sort ? 'desc' : q.order, SORT, 'date')} LIMIT ? OFFSET ?`, [...params, pageOf(req).limit, pageOf(req).offset]);
    if (isExport(req)) return exportCsv(req, res, { rows, total, file: `${C.table}.csv`, action: 'payment.export', entity: C.table, headers: ['N°', 'Statut', 'Date', 'Tiers', 'Mode', 'Référence', 'Montant', 'Affecté'], row: (r) => [r.number ?? '', r.status === 'recorded' ? 'Enregistré' : 'Annulé', csvDate(r.date_s), r.party_name, METHODS[r.method] ?? r.method, r.reference ?? '', csvMoney(r.amount), csvMoney(r.allocated)] });
    res.json({ data: rows.map((r) => dto(r)), meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
  }));
  router.get('/:id', requirePermission('payment.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const { p, al, extra } = await load(pool, req.auth.companyId, req.params.id);
    res.json({ data: dto(p, al, extra) });
  }));

  router.post('/', requirePermission('payment.write'), validate({ body: createBody }), asyncHandler(async (req, res) => {
    const b = req.body; const publicId = newPublicId();
    await withTransaction(async (conn) => {
      if (b.date > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date du règlement est dans le futur');
      const [[party]] = await conn.query(`SELECT id, name FROM ${C.party} WHERE company_id = ? AND public_id = ?`, [req.auth.companyId, b[partyIdKey]]);
      if (!party) throw new HttpError(422, 'UNKNOWN_REFERENCE', `${C.label} introuvable`);
      const { invs, total: allocated, currency: invCurrency } = await checkAllocations(conn, req.auth, party.id, b.allocations);
      if (b.currency && invCurrency && b.currency !== invCurrency) throw new HttpError(422, 'CURRENCY_MISMATCH', 'La devise du règlement diffère de celle des factures');
      const currency = invCurrency ?? b.currency ?? 'TND';
      const total = b.amount ?? allocated;
      if (cmpMoney(total, allocated) < 0) throw new HttpError(422, 'AMOUNT_BELOW_ALLOCATIONS', 'Le montant est inférieur au total des affectations');
      const series = b.date.slice(0, 4);
      const number = await nextDocNumber(conn, req.auth.companyId, C.docType, series);
      const [r] = await conn.query(`INSERT INTO ${C.table} (public_id, company_id, number, ${C.col}, payment_date, method, reference, amount, currency, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [publicId, req.auth.companyId, number, party.id, b.date, b.method, b.reference ?? null, total, currency, b.notes ?? null, req.auth.userId]);
      for (const a of b.allocations) {
        const inv = invs.find((i) => i.public_id === a.invoiceId);
        await conn.query(`INSERT INTO ${C.alloc} (payment_id, invoice_id, amount) VALUES (?,?,?)`, [r.insertId, inv.id, a.amount]);
        await refreshPaid(conn, inv.id);
      }
      const accountInternal = await linkPayment(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, { type: C.treasuryType, accountId: b.accountId, dueDate: b.dueDate, bankName: b.bankName,
        payment: { publicId, number, amount: total, currency, date: b.date, method: b.method, reference: b.reference, partyName: party.name } });
      if (accountInternal) await conn.query(`UPDATE ${C.table} SET account_id = ? WHERE id = ?`, [accountInternal, r.insertId]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${C.audit}.create`, entityType: C.table, entityId: publicId, ip: req.ip, meta: { number, amount: total, advance: subMoney(total, allocated), method: b.method, invoices: invs.map((i) => i.number) } });
      for (const inv of invs) await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: C.invAudit, entityType: C.invEntity, entityId: inv.public_id, ip: req.ip, meta: { payment: number, amount: b.allocations.find((a) => a.invoiceId === inv.public_id).amount } });
    });
    const { p, al, extra } = await load(pool, req.auth.companyId, publicId);
    res.status(201).json({ data: dto(p, al, extra) });
  }));


  // ---- Retenue à la source ajoutée après l'émission (oubli au départ) ----
  // La facture émise n'est pas modifiée : la retenue est un règlement de mode 'withholding' affecté à la facture
  // (déduit du reste à payer, annulable avec motif) + une fiche document_withholdings (taux, base, montant calculés ICI, côté serveur).
  const rsBody = z.object({
    invoiceId: z.string().uuid(), date: isoDate,
    rate: z.union([z.string(), z.number()]).transform((v) => String(v).trim().replace(',', '.')).refine((s) => /^\d{1,3}(\.\d{1,2})?$/.test(s) && Number(s) > 0 && Number(s) <= 100, 'Taux entre 0,01 et 100 % (2 décimales max)').transform((s) => fromScaled(toScaled(s, 2), 2)),
    certificateNumber: optText(60), notes: optText(500), dryRun: z.boolean().optional(),
  });
  const DIRECTION = kind === 'client' ? 'sales' : 'purchase';
  router.post('/withholding', requirePermission('payment.write'), validate({ body: rsBody }), asyncHandler(async (req, res) => {
    const b = req.body; const publicId = newPublicId(); let preview = null;
    await withTransaction(async (conn) => {
      if (b.date > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date de la retenue est dans le futur');
      const [[inv]] = await conn.query(`SELECT i.*, DATE_FORMAT(i.issue_date,'%Y-%m-%d') AS issue_s, ${CREDITED} AS credited FROM ${C.inv} i WHERE i.company_id = ? AND i.public_id = ? AND i.kind = 'invoice' FOR UPDATE`, [req.auth.companyId, b.invoiceId]);
      if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Facture introuvable');
      if (inv.status !== C.okStatus) throw new HttpError(409, 'INVALID_STATE', `La facture ${inv.number ?? ''} ${C.notOk}`);
      if (Number(inv.withholding_amount) > 0) throw new HttpError(409, 'WITHHOLDING_ALREADY_ON_INVOICE', 'Cette facture comporte déjà une retenue à la source');
      const [[active]] = await conn.query(`SELECT dw.id FROM document_withholdings dw JOIN ${C.table} p ON p.id = dw.payment_id AND p.status = 'recorded' WHERE dw.company_id = ? AND dw.direction = ? AND dw.invoice_id = ?`, [req.auth.companyId, DIRECTION, inv.id]);
      if (active) throw new HttpError(409, 'WITHHOLDING_ALREADY_ADDED', 'Une retenue à la source est déjà enregistrée sur cette facture (annulez-la d\'abord pour la refaire)');
      if (inv.issue_s && b.date < inv.issue_s) throw new HttpError(422, 'DATE_BEFORE_ISSUE', 'La date de la retenue précède la date de la facture');
      const base = inv.total_ttc; // TTC hors timbre
      const raw = toScaled(base, 3) * toScaled(b.rate, 2); const amountScaled = (raw + 5000n) / 10000n;
      const rsAmount = money(amountScaled);
      if (amountScaled <= 0n) throw new HttpError(422, 'WITHHOLDING_ZERO', 'Le montant de la retenue calculé est nul');
      const due = subMoney(subMoney(inv.net_payable, inv.paid_amount), inv.credited);
      if (cmpMoney(rsAmount, due) > 0) throw new HttpError(422, 'WITHHOLDING_EXCEEDS_BALANCE', `La retenue (${rsAmount}) dépasse le reste à payer (${cmpMoney(due, '0') < 0 ? '0.000' : due}). Annulez ou corrigez d'abord le règlement concerné.`);
      preview = { invoice: inv.number, base, rate: b.rate, amount: rsAmount, balanceBefore: due, balanceAfter: subMoney(due, rsAmount), currency: inv.currency };
      if (b.dryRun) return;
      const series = b.date.slice(0, 4);
      const number = await nextDocNumber(conn, req.auth.companyId, C.docType, series);
      const [r] = await conn.query(`INSERT INTO ${C.table} (public_id, company_id, number, ${C.col}, payment_date, method, reference, amount, currency, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [publicId, req.auth.companyId, number, inv[C.col], b.date, 'withholding', b.certificateNumber ?? null, rsAmount, inv.currency, b.notes ?? `Retenue à la source ${b.rate} % sur ${inv.number}`, req.auth.userId]);
      await conn.query(`INSERT INTO ${C.alloc} (payment_id, invoice_id, amount) VALUES (?,?,?)`, [r.insertId, inv.id, rsAmount]);
      await refreshPaid(conn, inv.id);
      await conn.query('INSERT INTO document_withholdings (company_id, direction, invoice_id, payment_id, rate, base_amount, amount, withholding_date, certificate_number, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [req.auth.companyId, DIRECTION, inv.id, r.insertId, b.rate, base, rsAmount, b.date, b.certificateNumber ?? null, b.notes ?? null, req.auth.userId]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${C.audit}.create`, entityType: C.table, entityId: publicId, ip: req.ip, meta: { number, amount: rsAmount, method: 'withholding', invoices: [inv.number] } });
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'withholding.add', entityType: C.invEntity, entityId: inv.public_id, ip: req.ip, meta: { payment: number, rate: b.rate, base, amount: rsAmount, date: b.date, certificate: b.certificateNumber ?? null } });
    });
    if (b.dryRun) return res.json({ data: { preview } });
    const { p, al, extra } = await load(pool, req.auth.companyId, publicId);
    res.status(201).json({ data: dto(p, al, extra), meta: { preview } });
  }));

  // Affectation du solde non affecté (avance) à des factures ouvertes du même tiers.
  router.post('/:id/allocate', requirePermission('payment.write'), validate({ params: idParam, body: z.object({ allocations: allocSchema.min(1, 'Choisissez au moins une facture') }) }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const [[p]] = await conn.query(`SELECT * FROM ${C.table} WHERE company_id = ? AND public_id = ? FOR UPDATE`, [req.auth.companyId, req.params.id]);
      if (!p) throw new HttpError(404, 'NOT_FOUND', 'Règlement introuvable');
      if (p.status !== 'recorded') throw new HttpError(409, 'INVALID_STATE', 'Règlement annulé');
      const { invs, total, currency } = await checkAllocations(conn, req.auth, p[C.col], req.body.allocations, { currency: p.currency });
      void currency;
      const [[cur]] = await conn.query(`SELECT COALESCE(SUM(amount),0) AS t FROM ${C.alloc} WHERE payment_id = ?`, [p.id]);
      const free = subMoney(p.amount, cur.t);
      if (cmpMoney(total, free) > 0) throw new HttpError(422, 'EXCEEDS_UNALLOCATED', `Montant supérieur au solde non affecté du règlement (${free})`);
      for (const a of req.body.allocations) {
        const inv = invs.find((i) => i.public_id === a.invoiceId);
        await conn.query(`INSERT INTO ${C.alloc} (payment_id, invoice_id, amount) VALUES (?,?,?) ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)`, [p.id, inv.id, a.amount]);
        await refreshPaid(conn, inv.id);
        await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: C.invAudit, entityType: C.invEntity, entityId: inv.public_id, ip: req.ip, meta: { payment: p.number, amount: a.amount, fromAdvance: true } });
      }
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${C.audit}.allocate`, entityType: C.table, entityId: p.public_id, ip: req.ip, meta: { number: p.number, amount: total } });
    });
    const { p, al, extra } = await load(pool, req.auth.companyId, req.params.id);
    res.json({ data: dto(p, al, extra) });
  }));

  router.post('/:id/cancel', requirePermission('payment.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
    await withTransaction((conn) => cancelPayment(conn, req.auth, req.params.id, req.body.reason, req.ip));
    const { p, al, extra } = await load(pool, req.auth.companyId, req.params.id);
    res.json({ data: dto(p, al, extra) });
  }));
  router.get('/:id/history', requirePermission('payment.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const { p } = await load(pool, req.auth.companyId, req.params.id);
    res.json({ data: await history(req.auth.companyId, C.table, p.public_id) });
  }));

  return { router, refreshPaid, cancelPayment };
}
