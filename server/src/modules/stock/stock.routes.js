// Stock : entrepôts, niveaux, valorisation, journal des mouvements, ajustements directs.
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
import { fromScaled } from '../../core/calc.js';
import { listQuerySchema, escapeLike, EXPORT_MAX } from '../../core/list.js';
import { csvDate, csvMoney, meta as listMeta, sendCsv } from '../../core/list-filters.js';
import { toCsv } from '../../core/csv.js';
import { idParam, todayTunis } from '../sales/common.js';
import { ensureDefaultWarehouse, findWarehouse, moveStock, signedScaled, lineCost } from './stock.service.js';
import { iso, qtyAny, costField, opt } from './schemas.js';
import vouchers from './vouchers.routes.js';
import counts from './counts.routes.js';

const router = Router();
router.use(authenticate);

// ---------- Entrepôts
const whDto = (w) => ({ id: w.public_id, code: w.code, name: w.name, address: w.address, isDefault: !!w.is_default, status: w.status });
const whBody = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, 'Code : 2 à 20 lettres, chiffres, - ou _'), name: z.string().trim().min(2).max(120), address: opt(z.string().trim().max(255)), isDefault: z.boolean().optional() });

router.get('/warehouses', requirePermission('stock.read'), asyncHandler(async (req, res) => {
  await withTransaction((c) => ensureDefaultWarehouse(c, req.auth.companyId, req.auth.userId));
  const [rows] = await pool.query(`SELECT w.*, (SELECT COALESCE(SUM(l.quantity <> 0), 0) FROM stock_levels l WHERE l.warehouse_id = w.id) AS n_products FROM warehouses w WHERE w.company_id = ? ORDER BY w.status, w.is_default DESC, w.name`, [req.auth.companyId]);
  res.json({ data: rows.map((w) => ({ ...whDto(w), productCount: Number(w.n_products) })) });
}));
router.post('/warehouses', requirePermission('stock.write'), validate({ body: whBody }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    await ensureDefaultWarehouse(conn, req.auth.companyId, req.auth.userId);
    await assertLimit(conn, req.auth.companyId, 'warehouses');
    const [[dup]] = await conn.query('SELECT 1 AS x FROM warehouses WHERE company_id = ? AND code = ?', [req.auth.companyId, req.body.code]);
    if (dup) throw new HttpError(409, 'DUPLICATE', 'Ce code d\'entrepôt existe déjà');
    if (req.body.isDefault) await conn.query('UPDATE warehouses SET is_default = 0 WHERE company_id = ?', [req.auth.companyId]);
    await conn.query('INSERT INTO warehouses (public_id, company_id, code, name, address, is_default, created_by) VALUES (?,?,?,?,?,?,?)', [publicId, req.auth.companyId, req.body.code, req.body.name, req.body.address ?? null, req.body.isDefault ? 1 : 0, req.auth.userId]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'warehouse.create', entityType: 'warehouses', entityId: publicId, ip: req.ip, meta: { code: req.body.code } });
  });
  const [[w]] = await pool.query('SELECT * FROM warehouses WHERE public_id = ?', [publicId]);
  res.status(201).json({ data: whDto(w) });
}));
router.put('/warehouses/:id', requirePermission('stock.write'), validate({ params: idParam, body: whBody }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const w = await findWarehouse(conn, req.auth.companyId, req.params.id, { activeOnly: false });
    const [[dup]] = await conn.query('SELECT 1 AS x FROM warehouses WHERE company_id = ? AND code = ? AND id <> ?', [req.auth.companyId, req.body.code, w.id]);
    if (dup) throw new HttpError(409, 'DUPLICATE', 'Ce code d\'entrepôt existe déjà');
    if (req.body.isDefault && w.status === 'active') await conn.query('UPDATE warehouses SET is_default = 0 WHERE company_id = ?', [req.auth.companyId]);
    await conn.query('UPDATE warehouses SET code = ?, name = ?, address = ?, is_default = ? WHERE id = ?', [req.body.code, req.body.name, req.body.address ?? null, req.body.isDefault && w.status === 'active' ? 1 : w.is_default, w.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'warehouse.update', entityType: 'warehouses', entityId: w.public_id, ip: req.ip });
  });
  const [[w]] = await pool.query('SELECT * FROM warehouses WHERE public_id = ?', [req.params.id]);
  res.json({ data: whDto(w) });
}));
router.post('/warehouses/:id/archive', requirePermission('stock.write'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const w = await findWarehouse(conn, req.auth.companyId, req.params.id, { activeOnly: false });
    const [[st]] = await conn.query('SELECT COUNT(*) AS n FROM stock_levels WHERE warehouse_id = ? AND quantity <> 0', [w.id]);
    if (st.n) throw new HttpError(409, 'HAS_STOCK', 'Cet entrepôt contient du stock : transférez-le ou ajustez-le avant archivage');
    const [[others]] = await conn.query("SELECT COUNT(*) AS n FROM warehouses WHERE company_id = ? AND status = 'active' AND id <> ?", [req.auth.companyId, w.id]);
    if (!others.n) throw new HttpError(409, 'LAST_WAREHOUSE', 'Il faut au moins un entrepôt actif');
    await conn.query("UPDATE warehouses SET status = 'archived', is_default = 0 WHERE id = ?", [w.id]);
    const [[d]] = await conn.query('SELECT COUNT(*) AS n FROM warehouses WHERE company_id = ? AND is_default = 1 AND status = \'active\'', [req.auth.companyId]);
    if (!d.n) await conn.query("UPDATE warehouses SET is_default = 1 WHERE id = (SELECT id FROM (SELECT id FROM warehouses WHERE company_id = ? AND status = 'active' ORDER BY id LIMIT 1) t)", [req.auth.companyId]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'warehouse.archive', entityType: 'warehouses', entityId: w.public_id, ip: req.ip });
  });
  res.json({ data: { ok: true } });
}));
router.post('/warehouses/:id/restore', requirePermission('stock.write'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const w = await findWarehouse(pool, req.auth.companyId, req.params.id, { activeOnly: false });
  await pool.query("UPDATE warehouses SET status = 'active' WHERE id = ?", [w.id]);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'warehouse.restore', entityType: 'warehouses', entityId: w.public_id, ip: req.ip });
  res.json({ data: { ok: true } });
}));

// ---------- Niveaux de stock et valorisation (coût moyen pondéré)
const LEVELS_Q = listQuerySchema.omit({ status: true }).extend({ warehouseId: z.string().uuid().optional(), below: z.enum(['1', 'true']).optional(), categoryId: z.string().uuid().optional() });
router.get('/levels/export', requirePermission('stock.read'), validate({ query: LEVELS_Q }), asyncHandler(async (req, res) => {
  const q = req.query; const cid = req.auth.companyId;
  let wh = null; if (q.warehouseId) wh = await findWarehouse(pool, cid, q.warehouseId, { activeOnly: false });
  const where = ["p.company_id = ?", "p.track_stock = 1", "p.type = 'product'", "p.status = 'active'"]; const params = [cid];
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)'); params.push(like, like, like); }
  if (q.categoryId) { where.push('c.public_id = ?'); params.push(q.categoryId); }
  if (q.below) where.push('p.stock_alert_threshold IS NOT NULL AND COALESCE(ps.quantity, 0) <= p.stock_alert_threshold');
  const qtyExpr = wh ? 'COALESCE(l.quantity, 0)' : 'COALESCE(ps.quantity, 0)';
  const from = `FROM products p LEFT JOIN product_stock ps ON ps.product_id = p.id LEFT JOIN product_categories c ON c.id = p.category_id ${wh ? 'LEFT JOIN stock_levels l ON l.product_id = p.id AND l.warehouse_id = ?' : ''}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, [...(wh ? [wh.id] : []), ...params]);
  const [rows] = await pool.query(`SELECT p.sku, p.name, p.unit, p.stock_alert_threshold, ${qtyExpr} AS qty, COALESCE(ps.avg_cost, 0) AS avg_cost, c.name AS category ${from} WHERE ${where.join(' AND ')} ORDER BY p.name, p.id LIMIT ${EXPORT_MAX}`, [...(wh ? [wh.id] : []), ...params]);
  await audit(null, { companyId: cid, userId: req.auth.userId, action: 'stock.levels_export', entityType: 'products', ip: req.ip, meta: { rows: rows.length, total } });
  const text = toCsv(['Référence', 'Article', 'Catégorie', 'Unité', 'Quantité', 'Coût moyen', 'Valeur', 'Seuil d\'alerte'],
    rows.map((r) => [r.sku ?? '', r.name, r.category ?? '', r.unit, csvMoney(r.qty), csvMoney(r.avg_cost), csvMoney(fromScaled(lineCost(signedScaled(r.qty, 4), signedScaled(r.avg_cost, 4)), 3)), csvMoney(r.stock_alert_threshold)]));
  sendCsv(res, 'niveaux-stock.csv', text, { total, shown: rows.length });
}));
router.get('/levels', requirePermission('stock.read'), validate({ query: LEVELS_Q }), asyncHandler(async (req, res) => {
  const q = req.query; const cid = req.auth.companyId;
  await withTransaction((c) => ensureDefaultWarehouse(c, cid, req.auth.userId));
  let wh = null; if (q.warehouseId) wh = await findWarehouse(pool, cid, q.warehouseId, { activeOnly: false });
  const where = ["p.company_id = ?", "p.track_stock = 1", "p.type = 'product'", "p.status = 'active'"]; const params = [cid];
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)'); params.push(like, like, like); }
  if (q.categoryId) { where.push('c.public_id = ?'); params.push(q.categoryId); }
  const qtyExpr = wh ? 'COALESCE(l.quantity, 0)' : 'COALESCE(ps.quantity, 0)';
  if (q.below) where.push(`p.stock_alert_threshold IS NOT NULL AND COALESCE(ps.quantity, 0) <= p.stock_alert_threshold`);
  const from = `FROM products p LEFT JOIN product_stock ps ON ps.product_id = p.id LEFT JOIN product_categories c ON c.id = p.category_id ${wh ? 'LEFT JOIN stock_levels l ON l.product_id = p.id AND l.warehouse_id = ?' : ''}`;
  const fromParams = wh ? [wh.id] : [];
  const [[agg]] = await pool.query(`SELECT COUNT(*) AS total, COALESCE(SUM(ROUND(${qtyExpr} * COALESCE(ps.avg_cost, 0), 3)), 0) AS value ${from} WHERE ${where.join(' AND ')}`, [...fromParams, ...params]);
  const [rows] = await pool.query(`SELECT p.id, p.public_id, p.sku, p.name, p.unit, p.stock_alert_threshold, ${qtyExpr} AS qty, COALESCE(ps.quantity, 0) AS total_qty, COALESCE(ps.avg_cost, 0) AS avg_cost, c.name AS category
    ${from} WHERE ${where.join(' AND ')} ORDER BY p.name, p.id LIMIT ? OFFSET ?`, [...fromParams, ...params, q.limit, (q.page - 1) * q.limit]);
  const ids = rows.map((r) => r.id); let per = [];
  if (ids.length) [per] = await pool.query('SELECT l.product_id, w.public_id, w.name, l.quantity FROM stock_levels l JOIN warehouses w ON w.id = l.warehouse_id WHERE l.product_id IN (?) AND l.quantity <> 0 ORDER BY w.name', [ids]);
  res.json({
    data: rows.map((r) => ({
      productId: r.public_id, sku: r.sku, name: r.name, unit: r.unit, category: r.category, quantity: r.qty, totalQuantity: r.total_qty, avgCost: r.avg_cost,
      value: fromScaled(lineCost(signedScaled(r.qty, 4), signedScaled(r.avg_cost, 4)), 3), threshold: r.stock_alert_threshold,
      belowThreshold: r.stock_alert_threshold !== null && Number(r.total_qty) <= Number(r.stock_alert_threshold),
      warehouses: per.filter((x) => x.product_id === r.id).map((x) => ({ id: x.public_id, name: x.name, quantity: x.quantity })),
    })),
    meta: { page: q.page, limit: q.limit, total: agg.total, pages: Math.max(1, Math.ceil(agg.total / q.limit)), totalValue: agg.value, valuation: 'Coût moyen pondéré' },
  });
}));

// ---------- Journal des mouvements (lecture seule)
const MOV_Q = listQuerySchema.omit({ status: true }).extend({ productId: z.string().uuid().optional(), warehouseId: z.string().uuid().optional(), kind: z.string().max(30).optional(), from: iso.optional(), to: iso.optional() });
const movParts = (req) => {
  const q = req.query; const where = ['m.company_id = ?']; const params = [req.auth.companyId];
  if (q.productId) { where.push('p.public_id = ?'); params.push(q.productId); }
  if (q.warehouseId) { where.push('w.public_id = ?'); params.push(q.warehouseId); }
  if (q.kind) { where.push('m.kind = ?'); params.push(q.kind); }
  if (q.from) { where.push('m.movement_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('m.movement_date <= ?'); params.push(q.to); }
  if (q.from && q.to && q.from > q.to) throw new HttpError(422, 'VALIDATION_ERROR', 'La date de début est postérieure à la date de fin');
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(p.name LIKE ? OR p.sku LIKE ? OR m.source_number LIKE ? OR m.reason LIKE ?)'); params.push(like, like, like, like); }
  return { q, where, params, from: 'FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id' };
};
const movDto = (m) => ({ id: m.public_id, date: m.d, kind: m.kind, productId: m.product_pid, productName: m.product_name, sku: m.sku, warehouseId: m.warehouse_pid, warehouseName: m.warehouse_name, quantity: m.quantity, unitCost: m.unit_cost, totalCost: m.total_cost, balanceAfter: m.balance_after, reason: m.reason, sourceType: m.source_type, sourceId: m.source_id, sourceNumber: m.source_number, createdAt: m.created_at });
const MOV_COLS = "m.*, DATE_FORMAT(m.movement_date,'%Y-%m-%d') AS d, p.public_id AS product_pid, p.name AS product_name, p.sku, w.name AS warehouse_name, w.public_id AS warehouse_pid";
router.get('/movements', requirePermission('stock.read'), validate({ query: MOV_Q }), asyncHandler(async (req, res) => {
  const { q, where, params, from } = movParts(req);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const [rows] = await pool.query(`SELECT ${MOV_COLS} ${from} WHERE ${where.join(' AND ')} ORDER BY m.movement_date DESC, m.id DESC LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
  res.json({ data: rows.map(movDto), meta: listMeta(q, total) });
}));
router.get('/movements/export', requirePermission('stock.read'), validate({ query: MOV_Q }), asyncHandler(async (req, res) => {
  const { where, params, from } = movParts(req);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const [rows] = await pool.query(`SELECT ${MOV_COLS} ${from} WHERE ${where.join(' AND ')} ORDER BY m.movement_date DESC, m.id DESC LIMIT ${EXPORT_MAX}`, params);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'stock.movements_export', entityType: 'stock_movements', ip: req.ip, meta: { rows: rows.length, total } });
  const text = toCsv(['Date', 'Type', 'Article', 'Référence', 'Entrepôt', 'Quantité', 'Coût unitaire', 'Valeur', 'Solde après', 'Document', 'Motif'],
    rows.map((m) => [csvDate(m.d), m.kind, m.product_name, m.sku ?? '', m.warehouse_name, csvMoney(m.quantity), csvMoney(m.unit_cost), csvMoney(m.total_cost), csvMoney(m.balance_after), m.source_number ?? '', m.reason ?? '']));
  sendCsv(res, 'mouvements-stock.csv', text, { total, shown: rows.length });
}));

// ---------- Ajustement direct, avec motif obligatoire (fixer la quantité ou appliquer un écart)
const adjBody = z.object({
  productId: z.string().uuid(), warehouseId: z.string().uuid(), mode: z.enum(['set', 'delta']), quantity: qtyAny, direction: z.enum(['in', 'out']).optional(),
  unitCost: opt(costField), date: iso.optional(), reason: z.string().trim().min(3, 'Motif requis (3 caractères minimum)').max(255),
}).refine((b) => b.mode === 'set' || b.direction, { message: 'Sens requis (entrée ou sortie)', path: ['direction'] });
router.post('/adjustments', requirePermission('stock.validate'), validate({ body: adjBody }), asyncHandler(async (req, res) => {
  const b = req.body; let result;
  await withTransaction(async (conn) => {
    const wh = await findWarehouse(conn, req.auth.companyId, b.warehouseId);
    const [[p]] = await conn.query('SELECT id, track_stock, type, name FROM products WHERE company_id = ? AND public_id = ?', [req.auth.companyId, b.productId]);
    if (!p) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Article introuvable');
    if (!p.track_stock || p.type !== 'product') throw new HttpError(422, 'NOT_TRACKED', `« ${p.name} » n'est pas suivi en stock`);
    const date = b.date ?? todayTunis(); if (date > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date est dans le futur');
    await conn.query('INSERT INTO product_stock (product_id, company_id) VALUES (?,?) ON DUPLICATE KEY UPDATE product_id = product_id', [p.id, req.auth.companyId]);
    await conn.query('INSERT INTO stock_levels (product_id, warehouse_id, company_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE product_id = product_id', [p.id, wh.id, req.auth.companyId]);
    const [[lv]] = await conn.query('SELECT quantity FROM stock_levels WHERE product_id = ? AND warehouse_id = ? FOR UPDATE', [p.id, wh.id]);
    const cur = signedScaled(lv.quantity, 4);
    const delta = b.mode === 'set' ? signedScaled(b.quantity, 4) - cur : (b.direction === 'in' ? 1n : -1n) * signedScaled(b.quantity, 4);
    if (delta === 0n) throw new HttpError(422, 'NO_CHANGE', 'Aucun écart : la quantité est déjà celle indiquée');
    const id = newPublicId();
    [result] = await moveStock(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, [{ productId: p.id, warehouseId: wh.id, kind: 'adjustment', quantity: fromScaled(delta, 4), unitCost: delta > 0n ? (b.unitCost ?? undefined) : undefined, date, reason: b.reason, source: { type: 'adjustment', id, lineId: 1 } }]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'stock.adjust', entityType: 'products', entityId: b.productId, ip: req.ip, meta: { warehouse: wh.code, delta: fromScaled(delta, 4), reason: b.reason } });
  });
  res.status(201).json({ data: result });
}));

router.use('/entries', vouchers('entry'));
router.use('/withdrawals', vouchers('withdrawal'));
router.use('/transfers', vouchers('transfer'));
router.use('/counts', counts);

export default router;
