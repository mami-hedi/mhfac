// Rapports : GET /reports (catalogue filtré par permissions) et GET /reports/:key?format=json|csv|xlsx|pdf.
// Droits : report.read + droit de lecture sur chaque module source. Isolation : company_id vient de la session uniquement.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { assertFeature, assertLimit } from '../../core/plan.js';
import { audit } from '../../core/audit.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { todayTunis } from '../sales/common.js';
import { CATALOG, REPORTS } from './definitions.js';
import { toCsv, toPdf, toXlsx, DISCLAIMER } from './render.js';

const router = Router(); router.use(authenticate);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ').refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), 'Date invalide');
const uuid = z.string().uuid();
const query = z.object({ format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'), from: iso.optional(), to: iso.optional(), asOf: iso.optional(), clientId: uuid.optional(), supplierId: uuid.optional(), productId: uuid.optional(), warehouseId: uuid.optional(),
  groupBy: z.enum(['day', 'week', 'month', 'year']).optional(), overdueOnly: z.enum(['1', 'true']).optional() });
const allowed = (perms, r) => perms.has('report.read') && r.needs.every((n) => perms.has(n));
const MIME = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };
const frDate = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

router.get('/', requirePermission('report.read'), (req, res) => { res.json({ data: CATALOG.filter((r) => allowed(req.auth.permissions, r)), meta: { disclaimer: DISCLAIMER } }); });

router.get('/:key', requirePermission('report.read'), validate({ params: z.object({ key: z.string().max(40) }), query }), asyncHandler(async (req, res) => {
  const def = REPORTS[req.params.key];
  if (!def) throw new HttpError(404, 'NOT_FOUND', 'Rapport inconnu');
  if (!allowed(req.auth.permissions, def)) throw new HttpError(403, 'FORBIDDEN', 'Permission insuffisante pour ce rapport', { required: def.needs });
  const q = req.query; const today = todayTunis();
  const from = q.from ?? `${today.slice(0, 4)}-01-01`; const to = q.to ?? today;
  if (from > to) throw new HttpError(422, 'INVALID_PERIOD', 'La date de début est postérieure à la date de fin');
  const params = { companyId: req.auth.companyId, from, to, asOf: q.asOf ?? today, clientId: q.clientId, supplierId: q.supplierId, productId: q.productId, warehouseId: q.warehouseId, groupBy: q.groupBy, overdueOnly: !!q.overdueOnly };
  const out = await def.run(params);
  const [[co]] = await pool.query('SELECT name, currency FROM companies WHERE id = ?', [req.auth.companyId]);
  const usesAsOf = def.filters.includes('asOf');
  const report = { key: req.params.key, title: def.title, note: def.note, ...out, period: usesAsOf ? { asOf: params.asOf } : { from, to } };
  const meta = { company: co.name, currency: co.currency, periodLabel: usesAsOf ? `Situation au ${frDate(params.asOf)} — montants en ${co.currency}` : `Période du ${frDate(from)} au ${frDate(to)} — montants en ${co.currency}`, generatedAt: new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' }) };
  if (q.format === 'json') return res.json({ data: report, meta: { ...meta, disclaimer: DISCLAIMER, rowCount: report.rows.length } });
  await assertFeature(pool, req.auth.companyId, 'reportsExport');
  await assertLimit(pool, req.auth.companyId, 'exportsPerMonth');
  const buf = q.format === 'csv' ? toCsv(report) : q.format === 'xlsx' ? await toXlsx(report, meta) : await toPdf(report, meta);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'report.export', entityType: 'reports', entityId: req.params.key, ip: req.ip, meta: { format: q.format, from, to, rows: report.rows.length } });
  res.set({ 'Content-Type': MIME[q.format], 'Content-Disposition': `attachment; filename="${req.params.key}_${usesAsOf ? params.asOf : `${from}_${to}`}.${q.format}"`, 'Cache-Control': 'no-store' }).send(buf);
}));

export default router;
