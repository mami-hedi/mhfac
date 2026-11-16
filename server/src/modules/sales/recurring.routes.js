import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { listQuerySchema, escapeLike } from '../../core/list.js';
import { bodyBase, history, idParam, prepare, todayTunis } from './common.js';
import { runDue } from './recurring.service.js';

const router = Router();
router.use(authenticate);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const iso = bodyBase.issueDate;

// Le modèle est validé comme une facture (mêmes règles) ; client et date sont portés par la série.
const { clientId: _c, issueDate: _i, ...templateShape } = bodyBase;
const body = z.object({
  clientId: z.string().uuid(), name: z.string().trim().min(2, 'Nom requis').max(120),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']), startDate: iso, endDate: iso.nullable().optional(),
  template: z.object(templateShape),
}).refine((b) => !b.endDate || b.endDate >= b.startDate, { message: 'La fin précède le début', path: ['endDate'] });

const SELECT = `SELECT r.*, DATE_FORMAT(r.start_date,'%Y-%m-%d') AS start_s, DATE_FORMAT(r.end_date,'%Y-%m-%d') AS end_s, DATE_FORMAT(r.next_run_date,'%Y-%m-%d') AS next_s, c.public_id AS client_pid, c.name AS client_name
  FROM recurring_invoices r JOIN clients c ON c.id = r.client_id`;
const row = (r) => ({ id: r.public_id, name: r.name, clientId: r.client_pid, clientName: r.client_name, frequency: r.frequency, startDate: r.start_s, endDate: r.end_s, nextRunDate: r.next_s, status: r.status, runCount: r.run_count, lastRunAt: r.last_run_at });
async function find(conn, companyId, publicId, forUpdate = false) {
  const [[r]] = await conn.query(`${SELECT} WHERE r.company_id = ? AND r.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId]);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Facture récurrente introuvable');
  return r;
}
async function detail(conn, companyId, publicId) {
  const r = await find(conn, companyId, publicId);
  const [runs] = await conn.query("SELECT DATE_FORMAT(u.period_date,'%Y-%m-%d') AS period, i.public_id, i.number, i.status, i.total_ttc FROM recurring_runs u JOIN invoices i ON i.id = u.invoice_id WHERE u.recurring_id = ? ORDER BY u.period_date DESC LIMIT 100", [r.id]);
  return { ...row(r), template: parse(r.template), runs: runs.map((x) => ({ period: x.period, invoiceId: x.public_id, number: x.number, status: x.status, totalTtc: x.total_ttc })) };
}
// Essai à blanc : mêmes contrôles qu'une facture (références, TVA, devise), aucune écriture.
const dryRun = (conn, auth, b) => prepare(conn, auth, { ...b.template, clientId: b.clientId, issueDate: todayTunis() });

router.get('/', requirePermission('invoice.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ status: z.enum(['active', 'paused', 'ended']).optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['r.company_id = ?']; const params = [req.auth.companyId];
  if (q.status) { where.push('r.status = ?'); params.push(q.status); }
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(r.name LIKE ? OR c.name LIKE ?)'); params.push(like, like); }
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM recurring_invoices r JOIN clients c ON c.id = r.client_id WHERE ${where.join(' AND ')}`, params);
  const [rows] = await pool.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
  res.json({ data: rows.map(row), meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
}));
router.get('/:id', requirePermission('invoice.read'), validate({ params: idParam }), asyncHandler(async (req, res) => { res.json({ data: await detail(pool, req.auth.companyId, req.params.id) }); }));
router.get('/:id/history', requirePermission('invoice.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await find(pool, req.auth.companyId, req.params.id); res.json({ data: await history(req.auth.companyId, 'recurring_invoices', req.params.id) });
}));

router.post('/', requirePermission('invoice.write'), validate({ body }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const p = await dryRun(conn, req.auth, req.body);
    await conn.query('INSERT INTO recurring_invoices (public_id, company_id, client_id, name, frequency, start_date, next_run_date, end_date, status, template, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [publicId, req.auth.companyId, p.client.id, req.body.name, req.body.frequency, req.body.startDate, req.body.startDate, req.body.endDate ?? null, 'active', JSON.stringify(req.body.template), req.auth.userId]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'recurring.create', entityType: 'recurring_invoices', entityId: publicId, ip: req.ip, meta: { name: req.body.name, frequency: req.body.frequency } });
  });
  res.status(201).json({ data: await detail(pool, req.auth.companyId, publicId) });
}));

router.put('/:id', requirePermission('invoice.write'), validate({ params: idParam, body }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await find(conn, req.auth.companyId, req.params.id, true);
    if (cur.status === 'ended') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Série terminée : créez-en une nouvelle');
    if (cur.run_count > 0 && (cur.start_s !== req.body.startDate || cur.frequency !== req.body.frequency)) throw new HttpError(409, 'DOCUMENT_LOCKED', 'Début et fréquence ne sont plus modifiables après la première génération');
    const p = await dryRun(conn, req.auth, req.body);
    const next = cur.run_count === 0 ? req.body.startDate : cur.next_s;
    await conn.query('UPDATE recurring_invoices SET client_id = ?, name = ?, frequency = ?, start_date = ?, next_run_date = ?, end_date = ?, template = ? WHERE id = ?',
      [p.client.id, req.body.name, req.body.frequency, req.body.startDate, next, req.body.endDate ?? null, JSON.stringify(req.body.template), cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'recurring.update', entityType: 'recurring_invoices', entityId: cur.public_id, ip: req.ip });
  });
  res.json({ data: await detail(pool, req.auth.companyId, req.params.id) });
}));

const transition = (path, from, to, action) => router.post(`/:id/${path}`, requirePermission('invoice.write'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await find(conn, req.auth.companyId, req.params.id, true);
    if (!from.includes(cur.status)) throw new HttpError(409, 'INVALID_TRANSITION', 'Action impossible dans l\'état actuel');
    await conn.query('UPDATE recurring_invoices SET status = ?, next_run_date = ? WHERE id = ?', [to, to === 'ended' ? null : cur.next_s, cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action, entityType: 'recurring_invoices', entityId: cur.public_id, ip: req.ip });
  });
  res.json({ data: await detail(pool, req.auth.companyId, req.params.id) });
}));
transition('pause', ['active'], 'paused', 'recurring.pause');
transition('resume', ['paused'], 'active', 'recurring.resume');
transition('end', ['active', 'paused'], 'ended', 'recurring.end');

// Génération manuelle des échéances dues (ce que fait aussi le planificateur). Produit des brouillons uniquement.
router.post('/run-due', requirePermission('invoice.write'), asyncHandler(async (req, res) => {
  res.json({ data: await runDue({ companyId: req.auth.companyId, ip: req.ip }) });
}));
router.post('/:id/run', requirePermission('invoice.write'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const cur = await find(pool, req.auth.companyId, req.params.id);
  res.json({ data: await runDue({ companyId: req.auth.companyId, recurringId: cur.id, ip: req.ip }) });
}));

router.delete('/:id', requirePermission('invoice.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await find(conn, req.auth.companyId, req.params.id, true);
    if (cur.run_count > 0) throw new HttpError(409, 'DOCUMENT_LOCKED', 'Des factures ont été générées : terminez la série plutôt que de la supprimer');
    await conn.query('DELETE FROM recurring_invoices WHERE id = ?', [cur.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'recurring.delete', entityType: 'recurring_invoices', entityId: cur.public_id, ip: req.ip, meta: { name: cur.name } });
  });
  res.status(204).end();
}));

export default router;
