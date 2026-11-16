// Facturation électronique — SIMULATION uniquement. Aucune connexion à TTN ni à une plateforme officielle.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { HttpError } from '../../utils/httpError.js';
import { requireFeature } from '../../core/plan.js';
import { audit } from '../../core/audit.js';
import { listQuerySchema, escapeLike } from '../../core/list.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { PROVIDER_INFO, NOTICE, SIMULATION_FORMAT } from './adapters.js';
import { STATUS_LABELS, getConfig, prepare, submit, refresh, retryDue } from './einvoice.service.js';

const router = Router();
router.use(authenticate);
// Module « bientôt disponible » : tant qu'il est désactivé, aucune route n'agit (ni lecture, ni préparation, ni envoi).
router.use((req, res, next) => (env.EINVOICE_MODULE === 'on' ? next() : next(new HttpError(501, 'MODULE_COMING_SOON', 'Ce module sera disponible bientôt.'))));
router.use(requireFeature('einvoice'));
const STATUSES = Object.keys(STATUS_LABELS);
const uuid = z.string().uuid();

const row = (r) => ({
  id: r.public_id, status: r.status, statusLabel: STATUS_LABELS[r.status], provider: r.provider, mode: r.mode, simulation: r.mode !== 'production', format: r.format,
  signatureStatus: r.signature_status, providerReference: r.provider_reference, attempts: r.attempts, lastError: r.last_error,
  nextRetryAt: r.next_retry_at, transmittedAt: r.transmitted_at, respondedAt: r.responded_at, createdAt: r.created_at,
  invoice: { id: r.invoice_pid, number: r.invoice_number, kind: r.invoice_kind, date: r.issue_date_s, currency: r.currency, totalTtc: r.total_ttc, clientName: r.client_name },
});
const SELECT = `SELECT t.*, i.public_id AS invoice_pid, i.number AS invoice_number, i.kind AS invoice_kind, DATE_FORMAT(i.issue_date,'%Y-%m-%d') AS issue_date_s, i.currency, i.total_ttc, c.name AS client_name
  FROM einvoice_transmissions t JOIN invoices i ON i.id = t.invoice_id JOIN clients c ON c.id = i.client_id`;

router.get('/config', requirePermission('einvoice.read'), asyncHandler(async (req, res) => {
  const c = await getConfig(pool, req.auth.companyId);
  res.json({ data: { provider: c.provider, scenario: c.scenario, providers: PROVIDER_INFO, notice: NOTICE, format: SIMULATION_FORMAT } });
}));

router.put('/config', requirePermission('einvoice.write'), validate({ body: z.object({ scenario: z.enum(['accept', 'reject', 'network_error']) }) }), asyncHandler(async (req, res) => {
  // Seul le fournisseur de simulation est utilisable ; le scénario sert à tester les cas de rejet / d'erreur réseau.
  await pool.query(`INSERT INTO einvoice_config (company_id, provider, scenario) VALUES (?, 'simulation', ?) ON DUPLICATE KEY UPDATE provider = 'simulation', scenario = VALUES(scenario)`, [req.auth.companyId, req.body.scenario]);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'einvoice.config', entityType: 'einvoice_config', ip: req.ip, meta: { scenario: req.body.scenario } });
  res.json({ data: { provider: 'simulation', scenario: req.body.scenario } });
}));

router.get('/transmissions', requirePermission('einvoice.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ status: z.enum(STATUSES).optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['t.company_id = ?']; const params = [req.auth.companyId];
  if (q.status) { where.push('t.status = ?'); params.push(q.status); }
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(i.number LIKE ? OR c.name LIKE ? OR t.provider_reference LIKE ?)'); params.push(like, like, like); }
  const w = where.join(' AND ');
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM einvoice_transmissions t JOIN invoices i ON i.id = t.invoice_id JOIN clients c ON c.id = i.client_id WHERE ${w}`, params);
  const [rows] = await pool.query(`${SELECT} WHERE ${w} ORDER BY t.id DESC LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
  const [counts] = await pool.query('SELECT status, COUNT(*) AS n FROM einvoice_transmissions WHERE company_id = ? GROUP BY status', [req.auth.companyId]);
  res.json({ data: rows.map(row), meta: { total, page: q.page, limit: q.limit, byStatus: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) } });
}));

router.get('/transmissions/:id', requirePermission('einvoice.read'), validate({ params: z.object({ id: uuid }) }), asyncHandler(async (req, res) => {
  const [[r]] = await pool.query(`${SELECT} WHERE t.company_id = ? AND t.public_id = ?`, [req.auth.companyId, req.params.id]);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Transmission introuvable');
  const [events] = await pool.query(`SELECT e.event, e.from_status, e.to_status, e.detail, e.created_at, u.full_name AS by_name FROM einvoice_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.transmission_id = ? ORDER BY e.id`, [r.id]);
  res.json({ data: { ...row(r), notice: NOTICE, payload: JSON.parse(r.payload), payloadHash: r.payload_hash, signature: r.signature,
    events: events.map((e) => ({ event: e.event, from: e.from_status, to: e.to_status, detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail, at: e.created_at, by: e.by_name })) } });
}));

// Transmission liée à une facture (affichée sur la fiche facture).
router.get('/invoices/:invoiceId', requirePermission('einvoice.read'), validate({ params: z.object({ invoiceId: uuid }) }), asyncHandler(async (req, res) => {
  const [[r]] = await pool.query(`${SELECT} WHERE t.company_id = ? AND i.public_id = ?`, [req.auth.companyId, req.params.invoiceId]);
  res.json({ data: r ? row(r) : null });
}));

const getByTx = async (companyId, publicId) => { const [[r]] = await pool.query(`${SELECT} WHERE t.company_id = ? AND t.public_id = ?`, [companyId, publicId]); return r; };

router.post('/invoices/:invoiceId/prepare', requirePermission('einvoice.write'), validate({ params: z.object({ invoiceId: uuid }) }), asyncHandler(async (req, res) => {
  const out = await prepare(req.auth, req.ip, req.params.invoiceId);
  const [[r]] = await pool.query(`${SELECT} WHERE t.id = ?`, [out.id]);
  res.status(out.created ? 201 : 200).json({ data: row(r) });
}));

router.post('/transmissions/:id/submit', requirePermission('einvoice.validate'), validate({ params: z.object({ id: uuid }) }), asyncHandler(async (req, res) => {
  const out = await submit(req.auth, req.ip, req.params.id); res.json({ data: row(await getByTx(req.auth.companyId, req.params.id)), result: out });
}));
router.post('/transmissions/:id/retry', requirePermission('einvoice.validate'), validate({ params: z.object({ id: uuid }) }), asyncHandler(async (req, res) => {
  const out = await submit(req.auth, req.ip, req.params.id, { event: 'retry' }); res.json({ data: row(await getByTx(req.auth.companyId, req.params.id)), result: out });
}));
router.post('/transmissions/:id/refresh', requirePermission('einvoice.validate'), validate({ params: z.object({ id: uuid }) }), asyncHandler(async (req, res) => {
  const out = await refresh(req.auth, req.ip, req.params.id); res.json({ data: row(await getByTx(req.auth.companyId, req.params.id)), result: out });
}));
router.post('/retry-due', requirePermission('einvoice.validate'), asyncHandler(async (req, res) => { res.json({ data: await retryDue(req.auth, req.ip) }); }));

export default router;
