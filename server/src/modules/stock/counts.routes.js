// Fiches d'inventaire : ouverture (liste des articles suivis) -> saisie des quantités comptées -> validation = ajustements des écarts.
// L'écart est calculé à la validation sur le stock RÉEL du moment (le théorique de la fiche n'est qu'une information) ; une fiche validée est définitive.
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { nextDocNumber } from '../../core/numbering.js';
import { fromScaled } from '../../core/calc.js';
import { listQuerySchema, escapeLike } from '../../core/list.js';
import { history, idParam, todayTunis } from '../sales/common.js';
import { ensureDefaultWarehouse, findWarehouse, moveStock, signedScaled } from './stock.service.js';
import { iso, opt, qtyAny } from './schemas.js';

const router = Router();

async function find(conn, companyId, publicId, forUpdate = false) {
  const [[c]] = await conn.query(`SELECT c.*, DATE_FORMAT(c.count_date,'%Y-%m-%d') AS date_s, w.public_id AS wh_pid, w.name AS wh_name FROM stock_counts c JOIN warehouses w ON w.id = c.warehouse_id WHERE c.company_id = ? AND c.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId]);
  if (!c) throw new HttpError(404, 'NOT_FOUND', "Fiche d'inventaire introuvable");
  return c;
}
async function dto(conn, companyId, publicId) {
  const c = await find(conn, companyId, publicId);
  const [lines] = await conn.query(`SELECT l.*, p.public_id AS product_pid, p.name, p.sku, p.unit, COALESCE(lv.quantity, 0) AS current_qty FROM stock_count_lines l JOIN products p ON p.id = l.product_id
    LEFT JOIN stock_levels lv ON lv.product_id = l.product_id AND lv.warehouse_id = ? WHERE l.count_id = ? ORDER BY p.name`, [c.warehouse_id, c.id]);
  return { id: c.public_id, number: c.number, status: c.status, date: c.date_s, warehouse: { id: c.wh_pid, name: c.wh_name }, reason: c.reason, notes: c.notes, cancelReason: c.cancel_reason, createdAt: c.created_at,
    lines: lines.map((l) => ({ id: l.id, productId: l.product_pid, name: l.name, sku: l.sku, unit: l.unit, expectedQuantity: l.expected_quantity, countedQuantity: l.counted_quantity, currentQuantity: c.status === 'draft' ? l.current_qty : null,
      difference: l.counted_quantity === null ? null : fromScaled(signedScaled(l.counted_quantity, 4) - signedScaled(c.status === 'draft' ? l.current_qty : l.expected_quantity, 4), 4) })) };
}

router.get('/', requirePermission('stock.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ status: z.enum(['draft', 'validated', 'cancelled']).optional() }) }), asyncHandler(async (req, res) => {
  await withTransaction((c) => ensureDefaultWarehouse(c, req.auth.companyId, req.auth.userId));
  const q = req.query; const where = ['c.company_id = ?']; const params = [req.auth.companyId];
  if (q.status) { where.push('c.status = ?'); params.push(q.status); }
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(c.number LIKE ? OR c.reason LIKE ?)'); params.push(like, like); }
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM stock_counts c WHERE ${where.join(' AND ')}`, params);
  const [rows] = await pool.query(`SELECT c.public_id, c.number, c.status, DATE_FORMAT(c.count_date,'%Y-%m-%d') AS d, w.name AS wh, (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id) AS n, (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id AND l.counted_quantity IS NOT NULL) AS counted
    FROM stock_counts c JOIN warehouses w ON w.id = c.warehouse_id WHERE ${where.join(' AND ')} ORDER BY c.count_date DESC, c.id DESC LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
  res.json({ data: rows.map((r) => ({ id: r.public_id, number: r.number, status: r.status, date: r.d, warehouse: r.wh, lineCount: Number(r.n), countedCount: Number(r.counted) })), meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
}));
router.get('/:id', requirePermission('stock.read'), validate({ params: idParam }), asyncHandler(async (req, res) => { res.json({ data: await dto(pool, req.auth.companyId, req.params.id) }); }));
router.get('/:id/history', requirePermission('stock.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await find(pool, req.auth.companyId, req.params.id); res.json({ data: await history(req.auth.companyId, 'stock_counts', req.params.id) });
}));

router.post('/', requirePermission('stock.write'), validate({ body: z.object({ warehouseId: z.string().uuid(), date: iso, categoryId: opt(z.string().uuid()).optional(), notes: opt(z.string().trim().max(3000)).optional() }) }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const wh = await findWarehouse(conn, req.auth.companyId, req.body.warehouseId);
    if (req.body.date > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date est dans le futur');
    const [prods] = await conn.query(`SELECT p.id, COALESCE(l.quantity, 0) AS qty FROM products p LEFT JOIN stock_levels l ON l.product_id = p.id AND l.warehouse_id = ? ${req.body.categoryId ? 'JOIN product_categories c ON c.id = p.category_id AND c.public_id = ?' : ''}
      WHERE p.company_id = ? AND p.track_stock = 1 AND p.type = 'product' AND p.status = 'active' ORDER BY p.name`, [wh.id, ...(req.body.categoryId ? [req.body.categoryId] : []), req.auth.companyId]);
    if (!prods.length) throw new HttpError(422, 'NO_PRODUCTS', "Aucun article suivi en stock à inventorier (activez « Suivre le stock » sur vos articles)");
    const [r] = await conn.query('INSERT INTO stock_counts (public_id, company_id, status, warehouse_id, count_date, notes, created_by) VALUES (?,?,?,?,?,?,?)', [publicId, req.auth.companyId, 'draft', wh.id, req.body.date, req.body.notes ?? null, req.auth.userId]);
    for (const p of prods) await conn.query('INSERT INTO stock_count_lines (count_id, product_id, expected_quantity) VALUES (?,?,?)', [r.insertId, p.id, p.qty]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'stock_count.create', entityType: 'stock_counts', entityId: publicId, ip: req.ip, meta: { lines: prods.length } });
  });
  res.status(201).json({ data: await dto(pool, req.auth.companyId, publicId) });
}));

router.put('/:id/lines', requirePermission('stock.write'), validate({ params: idParam, body: z.object({ lines: z.array(z.object({ productId: z.string().uuid(), countedQuantity: opt(qtyAny) })).min(1).max(2000), reason: opt(z.string().trim().max(255)).optional() }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const c = await find(conn, req.auth.companyId, req.params.id, true);
    if (c.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Fiche validée : elle ne se modifie plus');
    for (const l of req.body.lines) {
      const [r] = await conn.query('UPDATE stock_count_lines l JOIN products p ON p.id = l.product_id SET l.counted_quantity = ? WHERE l.count_id = ? AND p.public_id = ?', [l.countedQuantity ?? null, c.id, l.productId]);
      if (!r.affectedRows) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Article absent de la fiche');
    }
    if (req.body.reason !== undefined) await conn.query('UPDATE stock_counts SET reason = ? WHERE id = ?', [req.body.reason, c.id]);
  });
  res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
}));

router.post('/:id/validate', requirePermission('stock.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(3, 'Motif requis (3 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const c = await find(conn, req.auth.companyId, req.params.id, true);
    if (c.status !== 'draft') throw new HttpError(409, 'INVALID_TRANSITION', 'Cette fiche est déjà validée ou annulée');
    if (c.date_s > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date de la fiche est dans le futur');
    const wh = await findWarehouse(conn, req.auth.companyId, c.wh_pid);
    const [lines] = await conn.query('SELECT l.* FROM stock_count_lines l WHERE l.count_id = ? AND l.counted_quantity IS NOT NULL ORDER BY l.product_id', [c.id]);
    if (!lines.length) throw new HttpError(422, 'NOTHING_COUNTED', 'Aucune quantité comptée');
    const series = c.date_s.slice(0, 4);
    const number = await nextDocNumber(conn, req.auth.companyId, 'stock_count', series);
    // verrouille les niveaux dans l'ordre des articles, puis calcule l'écart sur le stock réel
    const items = [];
    for (const l of lines) {
      await conn.query('INSERT INTO product_stock (product_id, company_id) VALUES (?,?) ON DUPLICATE KEY UPDATE product_id = product_id', [l.product_id, req.auth.companyId]);
      await conn.query('INSERT INTO stock_levels (product_id, warehouse_id, company_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE product_id = product_id', [l.product_id, wh.id, req.auth.companyId]);
      const [[lv]] = await conn.query('SELECT quantity FROM stock_levels WHERE product_id = ? AND warehouse_id = ? FOR UPDATE', [l.product_id, wh.id]);
      const delta = signedScaled(l.counted_quantity, 4) - signedScaled(lv.quantity, 4);
      if (delta !== 0n) items.push({ productId: l.product_id, warehouseId: wh.id, kind: 'inventory', quantity: fromScaled(delta, 4), date: c.date_s, reason: `Inventaire ${number} : ${req.body.reason}`.slice(0, 255), source: { type: 'stock_count', id: c.public_id, number, lineId: l.id } });
    }
    if (items.length) await moveStock(conn, { companyId: req.auth.companyId, userId: req.auth.userId, allowNegative: false }, items);
    await conn.query("UPDATE stock_counts SET status = 'validated', number = ?, series = ?, reason = ?, validated_at = UTC_TIMESTAMP(), validated_by = ? WHERE id = ?", [number, series, req.body.reason, req.auth.userId, c.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'stock_count.validate', entityType: 'stock_counts', entityId: c.public_id, ip: req.ip, meta: { number, adjustments: items.length, reason: req.body.reason } });
  });
  res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
}));

router.delete('/:id', requirePermission('stock.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const c = await find(conn, req.auth.companyId, req.params.id, true);
    if (c.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Une fiche validée est définitive : corrigez par un nouvel inventaire ou un ajustement');
    await conn.query('DELETE FROM stock_counts WHERE id = ?', [c.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'stock_count.delete', entityType: 'stock_counts', entityId: c.public_id, ip: req.ip });
  });
  res.status(204).end();
}));

export default router;
