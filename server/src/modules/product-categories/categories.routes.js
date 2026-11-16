import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';

const router = Router();
router.use(authenticate);
const body = z.object({ name: z.string().trim().min(1).max(100) });
const idParam = z.object({ id: z.string().uuid() });
const dto = (r) => ({ id: r.public_id, name: r.name, productCount: Number(r.product_count ?? 0) });

router.get('/', requirePermission('product.read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count FROM product_categories c WHERE c.company_id = ? ORDER BY c.name', [req.auth.companyId]);
  res.json({ data: rows.map(dto) });
}));
router.post('/', requirePermission('product.write'), validate({ body }), asyncHandler(async (req, res) => {
  const publicId = newPublicId();
  await pool.query('INSERT INTO product_categories (public_id, company_id, name) VALUES (?,?,?)', [publicId, req.auth.companyId, req.body.name]);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'product_category.create', entityType: 'product_categories', entityId: publicId, ip: req.ip });
  res.status(201).json({ data: { id: publicId, name: req.body.name, productCount: 0 } });
}));
router.patch('/:id', requirePermission('product.write'), validate({ params: idParam, body }), asyncHandler(async (req, res) => {
  const [r] = await pool.query('UPDATE product_categories SET name = ? WHERE company_id = ? AND public_id = ?', [req.body.name, req.auth.companyId, req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'NOT_FOUND', 'Catégorie introuvable');
  res.json({ data: { id: req.params.id, name: req.body.name } });
}));
router.delete('/:id', requirePermission('product.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const [[c]] = await pool.query('SELECT id FROM product_categories WHERE company_id = ? AND public_id = ?', [req.auth.companyId, req.params.id]);
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'Catégorie introuvable');
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM products WHERE category_id = ?', [c.id]);
  if (n > 0) throw new HttpError(409, 'IN_USE', 'Cette catégorie contient des articles');
  await pool.query('DELETE FROM product_categories WHERE id = ?', [c.id]);
  res.status(204).end();
}));
export default router;
