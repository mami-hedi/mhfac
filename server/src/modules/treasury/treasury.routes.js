// Trésorerie : comptes (banque/caisse), écritures, virements internes, rapprochement manuel, chèques et effets.
// Aucune connexion bancaire : les écritures viennent des règlements, de saisies manuelles ou de l'encaissement des instruments.
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { addMoney, subMoney, toScaled, money } from '../../core/calc.js';
import { listQuerySchema, escapeLike } from '../../core/list.js';
import { idParam, todayTunis } from '../sales/common.js';
import { cancelPayment as cancelClientPayment } from '../payments/payments.routes.js';
import { cancelPayment as cancelSupplierPayment } from '../purchases/supplier-payments.routes.js';
import { addTransaction, balances, findAccount , addSigned } from './treasury.service.js';

const router = Router();
router.use(authenticate);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ').refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s); }, 'Date invalide');
const moneyField = (positive = true) => z.union([z.string(), z.number()]).transform((v) => String(v).trim().replace(',', '.')).refine((s) => /^\d{1,12}(\.\d{1,3})?$/.test(s) && (!positive || Number(s) > 0), positive ? 'Montant positif (3 décimales max)' : 'Montant invalide').transform((s) => money(toScaled(s, 3)));
const optText = (max) => z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(max).nullable().optional());
const reason = z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255);
const notFuture = (d) => { if (d > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date est dans le futur'); };

// ───────── Comptes ─────────
const accountBody = z.object({
  code: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z0-9_-]{2,20}$/, 'Code : 2 à 20 caractères (lettres, chiffres, - _)')),
  name: z.string().trim().min(2, 'Nom trop court').max(120), type: z.enum(['bank', 'cash']).default('bank'),
  currency: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{3}$/, 'Devise ISO à 3 lettres')).default('TND'),
  bankName: optText(120), accountNumber: optText(40), openingBalance: moneyField(false).default('0.000'), openingDate: isoDate.optional(),
});
const accountDto = (a, bal) => ({
  id: a.public_id, code: a.code, name: a.name, type: a.type, currency: a.currency, bankName: a.bank_name, accountNumber: a.account_number, openingBalance: a.opening_balance, openingDate: a.opening_date_s, status: a.status,
  balance: bal?.balance ?? a.opening_balance, reconciledBalance: bal?.reconciledBalance ?? a.opening_balance, totalIn: bal?.totalIn ?? '0.000', totalOut: bal?.totalOut ?? '0.000',
});
const ACC_SEL = "SELECT a.*, DATE_FORMAT(a.opening_date,'%Y-%m-%d') AS opening_date_s FROM treasury_accounts a";

router.get('/accounts', requirePermission('treasury.read'), validate({ query: z.object({ status: z.enum(['active', 'archived']).optional() }) }), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(`${ACC_SEL} WHERE a.company_id = ? ${req.query.status ? 'AND a.status = ?' : ''} ORDER BY a.status, a.type, a.name`, req.query.status ? [req.auth.companyId, req.query.status] : [req.auth.companyId]);
  const bal = await balances(pool, req.auth.companyId);
  res.json({ data: rows.map((a) => accountDto(a, bal.get(Number(a.id)))) });
}));
router.get('/accounts/:id', requirePermission('treasury.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const a = await findAccount(pool, req.auth.companyId, req.params.id, { activeOnly: false });
  res.json({ data: accountDto(a, (await balances(pool, req.auth.companyId, [a.id])).get(Number(a.id))) });
}));
router.post('/accounts', requirePermission('treasury.write'), validate({ body: accountBody }), asyncHandler(async (req, res) => {
  const b = req.body; const publicId = newPublicId();
  await withTransaction(async (conn) => {
    try {
      await conn.query('INSERT INTO treasury_accounts (public_id, company_id, code, name, type, currency, bank_name, account_number, opening_balance, opening_date, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [publicId, req.auth.companyId, b.code, b.name, b.type, b.currency, b.bankName ?? null, b.accountNumber ?? null, b.openingBalance, b.openingDate ?? todayTunis(), req.auth.userId]);
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'DUPLICATE_CODE', `Le code « ${b.code} » existe déjà`); throw e; }
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'treasury_account.create', entityType: 'treasury_accounts', entityId: publicId, ip: req.ip, meta: { code: b.code, openingBalance: b.openingBalance } });
  });
  const a = await findAccount(pool, req.auth.companyId, publicId, { activeOnly: false });
  res.status(201).json({ data: accountDto(a) });
}));
router.put('/accounts/:id', requirePermission('treasury.write'), validate({ params: idParam, body: accountBody.omit({ code: true }).partial({ type: true, currency: true, openingBalance: true }) }), asyncHandler(async (req, res) => {
  const b = req.body;
  await withTransaction(async (conn) => {
    const a = await findAccount(conn, req.auth.companyId, req.params.id, { activeOnly: false, forUpdate: true });
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM treasury_transactions WHERE account_id = ?', [a.id]);
    const [[{ m }]] = await conn.query('SELECT COUNT(*) AS m FROM payments WHERE account_id = ?', [a.id]);
    const used = n > 0 || m > 0;
    const sensitive = (b.type && b.type !== a.type) || (b.currency && b.currency !== a.currency) || (b.openingBalance && b.openingBalance !== a.opening_balance) || (b.openingDate && b.openingDate !== a.opening_date_s);
    if (used && sensitive) throw new HttpError(409, 'ACCOUNT_USED', 'Ce compte a des écritures : type, devise, solde et date d\'ouverture ne sont plus modifiables');
    await conn.query('UPDATE treasury_accounts SET name = ?, bank_name = ?, account_number = ?, type = ?, currency = ?, opening_balance = ?, opening_date = ? WHERE id = ?',
      [b.name, b.bankName ?? null, b.accountNumber ?? null, b.type ?? a.type, b.currency ?? a.currency, b.openingBalance ?? a.opening_balance, b.openingDate ?? a.opening_date_s, a.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'treasury_account.update', entityType: 'treasury_accounts', entityId: a.public_id, ip: req.ip });
  });
  const a = await findAccount(pool, req.auth.companyId, req.params.id, { activeOnly: false });
  res.json({ data: accountDto(a, (await balances(pool, req.auth.companyId, [a.id])).get(Number(a.id))) });
}));
for (const [path, status] of [['archive', 'archived'], ['restore', 'active']]) {
  router.post(`/accounts/:id/${path}`, requirePermission('treasury.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const a = await findAccount(pool, req.auth.companyId, req.params.id, { activeOnly: false });
    await pool.query('UPDATE treasury_accounts SET status = ? WHERE id = ?', [status, a.id]);
    await audit(pool, { companyId: req.auth.companyId, userId: req.auth.userId, action: `treasury_account.${path}`, entityType: 'treasury_accounts', entityId: a.public_id, ip: req.ip });
    res.json({ data: accountDto({ ...a, status }, (await balances(pool, req.auth.companyId, [a.id])).get(Number(a.id))) });
  }));
}

// ───────── Écritures ─────────
const TX_SEL = `SELECT t.*, DATE_FORMAT(t.tx_date,'%Y-%m-%d') AS d, a.public_id AS acc_pid, a.name AS acc_name, a.currency AS acc_currency FROM treasury_transactions t JOIN treasury_accounts a ON a.id = t.account_id`;
const txDto = (t) => ({
  id: t.public_id, number: t.number, date: t.d, direction: t.direction, amount: t.amount, currency: t.acc_currency, kind: t.kind, label: t.label, reference: t.reference, status: t.status,
  reconciled: !!t.reconciled, account: { id: t.acc_pid, name: t.acc_name }, source: t.source_type && t.kind !== 'transfer' ? { type: t.source_type, id: t.source_id } : null, transferGroup: t.transfer_group, cancelReason: t.cancel_reason,
});

router.get('/transactions', requirePermission('treasury.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({
  accountId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional(), kind: z.enum(['client_payment', 'supplier_payment', 'instrument', 'manual', 'transfer']).optional(), direction: z.enum(['in', 'out']).optional(),
  reconciled: z.enum(['0', '1']).optional(), status: z.enum(['recorded', 'cancelled']).optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['t.company_id = ?']; const params = [req.auth.companyId];
  if (q.accountId) { where.push('a.public_id = ?'); params.push(q.accountId); }
  if (q.from) { where.push('t.tx_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('t.tx_date <= ?'); params.push(q.to); }
  if (q.kind) { where.push('t.kind = ?'); params.push(q.kind); }
  if (q.direction) { where.push('t.direction = ?'); params.push(q.direction); }
  if (q.reconciled) { where.push('t.reconciled = ?'); params.push(Number(q.reconciled)); }
  if (q.status) { where.push('t.status = ?'); params.push(q.status); }
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(t.number LIKE ? OR t.label LIKE ? OR t.reference LIKE ?)'); params.push(like, like, like); }
  const from = 'FROM treasury_transactions t JOIN treasury_accounts a ON a.id = t.account_id';
  const [[agg]] = await pool.query(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN t.status = 'recorded' AND t.direction = 'in' THEN t.amount END),0) AS t_in, COALESCE(SUM(CASE WHEN t.status = 'recorded' AND t.direction = 'out' THEN t.amount END),0) AS t_out ${from} WHERE ${where.join(' AND ')}`, params);
  const [rows] = await pool.query(`${TX_SEL} WHERE ${where.join(' AND ')} ORDER BY t.tx_date DESC, t.id DESC LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
  res.json({ data: rows.map(txDto), meta: { page: q.page, limit: q.limit, total: agg.total, pages: Math.max(1, Math.ceil(agg.total / q.limit)), totalIn: agg.t_in, totalOut: agg.t_out } });
}));

const manualBody = z.object({ accountId: z.string().uuid(), date: isoDate, direction: z.enum(['in', 'out']), amount: moneyField(), label: z.string().trim().min(2, 'Libellé requis').max(255), reference: optText(120) });
router.post('/transactions', requirePermission('treasury.write'), validate({ body: manualBody }), asyncHandler(async (req, res) => {
  const b = req.body; let created;
  await withTransaction(async (conn) => {
    notFuture(b.date);
    const account = await findAccount(conn, req.auth.companyId, b.accountId);
    created = await addTransaction(conn, req.auth, { account, date: b.date, direction: b.direction, amount: b.amount, kind: 'manual', label: b.label, reference: b.reference });
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'treasury_tx.create', entityType: 'treasury_transactions', entityId: created.publicId, ip: req.ip, meta: { number: created.number, direction: b.direction, amount: b.amount, account: account.code } });
  });
  const [[t]] = await pool.query(`${TX_SEL} WHERE t.company_id = ? AND t.public_id = ?`, [req.auth.companyId, created.publicId]);
  res.status(201).json({ data: txDto(t) });
}));

// Virement interne : deux écritures liées (sortie du compte source, entrée sur le compte cible), même devise.
router.post('/transfers', requirePermission('treasury.write'), validate({ body: z.object({ fromAccountId: z.string().uuid(), toAccountId: z.string().uuid(), date: isoDate, amount: moneyField(), label: optText(255), reference: optText(120) }) }), asyncHandler(async (req, res) => {
  const b = req.body; const group = newPublicId(); let out; let inn;
  await withTransaction(async (conn) => {
    notFuture(b.date);
    if (b.fromAccountId === b.toAccountId) throw new HttpError(422, 'SAME_ACCOUNT', 'Les deux comptes doivent être différents');
    const from = await findAccount(conn, req.auth.companyId, b.fromAccountId); const to = await findAccount(conn, req.auth.companyId, b.toAccountId);
    if (from.currency !== to.currency) throw new HttpError(422, 'CURRENCY_MISMATCH', 'Un virement interne se fait entre comptes de même devise');
    const label = b.label ?? `Virement ${from.name} → ${to.name}`;
    out = await addTransaction(conn, req.auth, { account: from, date: b.date, direction: 'out', amount: b.amount, kind: 'transfer', label, reference: b.reference, sourceType: 'transfer', sourceId: group, transferGroup: group });
    inn = await addTransaction(conn, req.auth, { account: to, date: b.date, direction: 'in', amount: b.amount, kind: 'transfer', label, reference: b.reference, sourceType: 'transfer', sourceId: group, transferGroup: group });
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'treasury_tx.transfer', entityType: 'treasury_transactions', entityId: group, ip: req.ip, meta: { from: from.code, to: to.code, amount: b.amount, numbers: [out.number, inn.number] } });
  });
  const [rows] = await pool.query(`${TX_SEL} WHERE t.company_id = ? AND t.transfer_group = ? ORDER BY t.id`, [req.auth.companyId, group]);
  res.status(201).json({ data: rows.map(txDto) });
}));

// Annulation : saisies manuelles et virements uniquement (une écriture liée à un règlement s'annule avec le règlement). Rapprochée = refusée.
router.post('/transactions/:id/cancel', requirePermission('treasury.validate'), validate({ params: idParam, body: z.object({ reason }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const [[t]] = await conn.query('SELECT * FROM treasury_transactions WHERE company_id = ? AND public_id = ? FOR UPDATE', [req.auth.companyId, req.params.id]);
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'Écriture introuvable');
    if (t.status !== 'recorded') throw new HttpError(409, 'INVALID_TRANSITION', 'Écriture déjà annulée');
    if (!['manual', 'transfer'].includes(t.kind)) throw new HttpError(409, 'LINKED_TRANSACTION', 'Cette écriture provient d\'un règlement ou d\'un chèque : annulez le règlement correspondant');
    const [group] = t.transfer_group ? await conn.query('SELECT * FROM treasury_transactions WHERE transfer_group = ? ORDER BY id FOR UPDATE', [t.transfer_group]) : [[t]];
    const locked = group.find((g) => g.reconciled);
    if (locked) throw new HttpError(409, 'RECONCILED', `L'écriture ${locked.number} est rapprochée : annulez le rapprochement d'abord`);
    for (const g of group) await conn.query("UPDATE treasury_transactions SET status = 'cancelled', cancel_reason = ?, cancelled_at = UTC_TIMESTAMP() WHERE id = ?", [req.body.reason, g.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'treasury_tx.cancel', entityType: 'treasury_transactions', entityId: t.public_id, ip: req.ip, meta: { number: t.number, reason: req.body.reason } });
  });
  const [[t]] = await pool.query(`${TX_SEL} WHERE t.company_id = ? AND t.public_id = ?`, [req.auth.companyId, req.params.id]);
  res.json({ data: txDto(t) });
}));

// Rapprochement manuel : pointage des écritures confrontées au relevé de la banque (aucune connexion bancaire).
router.post('/transactions/reconcile', requirePermission('treasury.validate'), validate({ body: z.object({ ids: z.array(z.string().uuid()).min(1).max(200), reconciled: z.boolean() }) }), asyncHandler(async (req, res) => {
  let n = 0;
  await withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT id, status FROM treasury_transactions WHERE company_id = ? AND public_id IN (?) FOR UPDATE', [req.auth.companyId, req.body.ids]);
    if (rows.length !== new Set(req.body.ids).size) throw new HttpError(404, 'NOT_FOUND', 'Écriture introuvable');
    if (rows.some((r) => r.status !== 'recorded')) throw new HttpError(409, 'INVALID_STATE', 'Une écriture annulée ne se rapproche pas');
    const [r] = await conn.query(`UPDATE treasury_transactions SET reconciled = ?, reconciled_at = ${req.body.reconciled ? 'UTC_TIMESTAMP()' : 'NULL'}, reconciled_by = ? WHERE id IN (?)`, [req.body.reconciled ? 1 : 0, req.body.reconciled ? req.auth.userId : null, rows.map((x) => x.id)]);
    n = r.affectedRows;
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: req.body.reconciled ? 'treasury_tx.reconcile' : 'treasury_tx.unreconcile', entityType: 'treasury_transactions', entityId: req.body.ids[0], ip: req.ip, meta: { count: n } });
  });
  res.json({ data: { updated: n } });
}));

// ───────── Chèques et effets ─────────
const INS_SEL = `SELECT i.*, DATE_FORMAT(i.due_date,'%Y-%m-%d') AS due_s, DATE_FORMAT(i.deposited_at,'%Y-%m-%d') AS dep_s, DATE_FORMAT(i.cleared_at,'%Y-%m-%d') AS clr_s, DATE_FORMAT(i.bounced_at,'%Y-%m-%d') AS bnc_s, a.public_id AS acc_pid, a.name AS acc_name
  FROM treasury_instruments i LEFT JOIN treasury_accounts a ON a.id = i.account_id`;
const insDto = (i) => ({
  id: i.public_id, direction: i.direction, type: i.type, number: i.instrument_number, bankName: i.bank_name, partyName: i.party_name, amount: i.amount, currency: i.currency, dueDate: i.due_s, status: i.status,
  overdue: ['pending', 'deposited'].includes(i.status) && !!i.due_s && i.due_s < todayTunis(), account: i.acc_pid ? { id: i.acc_pid, name: i.acc_name } : null,
  payment: { type: i.payment_type, id: i.payment_id, number: i.payment_number }, depositedAt: i.dep_s, clearedAt: i.clr_s, bouncedAt: i.bnc_s, note: i.note,
});
async function loadInstrument(conn, companyId, publicId, forUpdate = false) {
  const [[i]] = await conn.query(`SELECT * FROM treasury_instruments WHERE company_id = ? AND public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId]);
  if (!i) throw new HttpError(404, 'NOT_FOUND', 'Chèque ou effet introuvable');
  return i;
}
const insOut = async (companyId, publicId) => { const [[i]] = await pool.query(`${INS_SEL} WHERE i.company_id = ? AND i.public_id = ?`, [companyId, publicId]); return insDto(i); };

router.get('/instruments', requirePermission('treasury.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({
  status: z.enum(['pending', 'deposited', 'cleared', 'bounced', 'cancelled']).optional(), direction: z.enum(['received', 'issued']).optional(), type: z.enum(['cheque', 'bill']).optional(), overdue: z.enum(['1', 'true']).optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['i.company_id = ?']; const params = [req.auth.companyId];
  if (q.status) { where.push('i.status = ?'); params.push(q.status); }
  if (q.direction) { where.push('i.direction = ?'); params.push(q.direction); }
  if (q.type) { where.push('i.type = ?'); params.push(q.type); }
  if (q.overdue) { where.push("i.status IN ('pending','deposited')"); where.push('i.due_date < ?'); params.push(todayTunis()); }
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(i.party_name LIKE ? OR i.instrument_number LIKE ? OR i.payment_number LIKE ? OR i.bank_name LIKE ?)'); params.push(like, like, like, like); }
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM treasury_instruments i WHERE ${where.join(' AND ')}`, params);
  const [rows] = await pool.query(`${INS_SEL} WHERE ${where.join(' AND ')} ORDER BY (i.status IN ('pending','deposited')) DESC, i.due_date, i.id LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
  res.json({ data: rows.map(insDto), meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
}));

router.post('/instruments/:id/deposit', requirePermission('treasury.validate'), validate({ params: idParam, body: z.object({ date: isoDate, accountId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const i = await loadInstrument(conn, req.auth.companyId, req.params.id, true);
    if (i.direction !== 'received') throw new HttpError(409, 'INVALID_STATE', 'Seuls les chèques et effets reçus se remettent en banque');
    if (i.status !== 'pending') throw new HttpError(409, 'INVALID_TRANSITION', 'Déjà remis, encaissé, impayé ou annulé');
    notFuture(req.body.date);
    let accountId = i.account_id;
    if (req.body.accountId) { const a = await findAccount(conn, req.auth.companyId, req.body.accountId); if (a.currency !== i.currency) throw new HttpError(422, 'CURRENCY_MISMATCH', 'Devise du compte différente'); accountId = a.id; }
    await conn.query("UPDATE treasury_instruments SET status = 'deposited', deposited_at = ?, account_id = ? WHERE id = ?", [req.body.date, accountId, i.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'treasury_instrument.deposit', entityType: 'treasury_instruments', entityId: i.public_id, ip: req.ip, meta: { payment: i.payment_number } });
  });
  res.json({ data: await insOut(req.auth.companyId, req.params.id) });
}));

// Encaissement (reçu) ou débit (émis) : c'est ici seulement que l'argent entre ou sort du compte.
router.post('/instruments/:id/clear', requirePermission('treasury.validate'), validate({ params: idParam, body: z.object({ date: isoDate, accountId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const i = await loadInstrument(conn, req.auth.companyId, req.params.id, true);
    if (!['pending', 'deposited'].includes(i.status)) throw new HttpError(409, 'INVALID_TRANSITION', 'Seul un chèque ou un effet en attente ou remis peut être encaissé');
    notFuture(req.body.date);
    let account;
    if (req.body.accountId) account = await findAccount(conn, req.auth.companyId, req.body.accountId);
    else if (i.account_id) { const [[a]] = await conn.query('SELECT public_id FROM treasury_accounts WHERE id = ?', [i.account_id]); account = await findAccount(conn, req.auth.companyId, a.public_id); }
    else throw new HttpError(422, 'ACCOUNT_REQUIRED', 'Choisissez le compte à créditer ou débiter');
    if (account.currency !== i.currency) throw new HttpError(422, 'CURRENCY_MISMATCH', `Le compte « ${account.name} » est en ${account.currency}, l'instrument en ${i.currency}`);
    const received = i.direction === 'received';
    await addTransaction(conn, req.auth, { account, date: req.body.date, direction: received ? 'in' : 'out', amount: i.amount, kind: 'instrument', label: `${i.type === 'cheque' ? 'Chèque' : 'Effet'} ${i.instrument_number ?? ''} — ${i.party_name} (${i.payment_number})`.replace('  ', ' '), reference: i.instrument_number, sourceType: 'instrument', sourceId: i.public_id });
    await conn.query("UPDATE treasury_instruments SET status = 'cleared', cleared_at = ?, account_id = ? WHERE id = ?", [req.body.date, account.id, i.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'treasury_instrument.clear', entityType: 'treasury_instruments', entityId: i.public_id, ip: req.ip, meta: { payment: i.payment_number, amount: i.amount, account: account.code } });
  });
  res.json({ data: await insOut(req.auth.companyId, req.params.id) });
}));

// Impayé : le règlement lié est annulé (soldes des factures rétablis) ; l'instrument est conservé avec le statut « impayé ».
router.post('/instruments/:id/bounce', requirePermission('treasury.validate'), validate({ params: idParam, body: z.object({ date: isoDate, reason }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const i = await loadInstrument(conn, req.auth.companyId, req.params.id, true);
    if (!['pending', 'deposited'].includes(i.status)) throw new HttpError(409, 'INVALID_TRANSITION', 'Seul un chèque ou un effet en attente ou remis peut être déclaré impayé');
    notFuture(req.body.date);
    const cancel = i.payment_type === 'client_payment' ? cancelClientPayment : cancelSupplierPayment;
    await cancel(conn, req.auth, i.payment_id, `Impayé : ${req.body.reason}`, req.ip);
    await conn.query("UPDATE treasury_instruments SET status = 'bounced', bounced_at = ?, note = ? WHERE id = ?", [req.body.date, req.body.reason, i.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'treasury_instrument.bounce', entityType: 'treasury_instruments', entityId: i.public_id, ip: req.ip, meta: { payment: i.payment_number, reason: req.body.reason } });
  });
  res.json({ data: await insOut(req.auth.companyId, req.params.id) });
}));

// ───────── Synthèse ─────────
router.get('/summary', requirePermission('treasury.read'), asyncHandler(async (req, res) => {
  const [accounts] = await pool.query(`${ACC_SEL} WHERE a.company_id = ? AND a.status = 'active'`, [req.auth.companyId]);
  const bal = await balances(pool, req.auth.companyId);
  const byCurrency = {};
  for (const a of accounts) { const b = bal.get(Number(a.id)); byCurrency[a.currency] ??= { balance: '0.000', bank: '0.000', cash: '0.000' }; byCurrency[a.currency].balance = addSigned(byCurrency[a.currency].balance, b.balance); byCurrency[a.currency][a.type] = addSigned(byCurrency[a.currency][a.type], b.balance); }
  const [ins] = await pool.query("SELECT direction, currency, COALESCE(SUM(amount),0) AS total, COUNT(*) AS n, SUM(due_date < ?) AS late FROM treasury_instruments WHERE company_id = ? AND status IN ('pending','deposited') GROUP BY direction, currency", [todayTunis(), req.auth.companyId]);
  res.json({ data: { accounts: accounts.length, byCurrency, instruments: ins.map((r) => ({ direction: r.direction, currency: r.currency, total: r.total, count: r.n, overdue: Number(r.late ?? 0) })) } });
}));
void subMoney;

export default router;
