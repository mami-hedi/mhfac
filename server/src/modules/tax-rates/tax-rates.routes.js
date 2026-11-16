import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate, asPatch } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { DEFAULT_TAX_RATES } from './defaults.js';

export async function seedDefaultTaxRates(conn, companyId) {
  for (const t of DEFAULT_TAX_RATES) {
    await conn.query('INSERT INTO tax_rates (public_id, company_id, name, rate, kind, is_default, notes) VALUES (?,?,?,?,?,?,?)',
      [newPublicId(), companyId, t.name, t.rate, t.kind, t.isDefault, 'Valeur indicative à valider avec votre comptable']);
  }
}

const dto = (r) => ({ id: r.public_id, name: r.name, rate: r.rate, kind: r.kind, isDefault: !!r.is_default, isActive: !!r.is_active, notes: r.notes });
const rate = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100 || String(v).trim() === '') { ctx.addIssue({ code: 'custom', message: 'Taux entre 0 et 100' }); return z.NEVER; }
  if (Math.round(n * 100) / 100 !== n) { ctx.addIssue({ code: 'custom', message: '2 décimales maximum' }); return z.NEVER; }
  return n.toFixed(2);
});
const base = { name: z.string().trim().min(1).max(60), rate, kind: z.enum(['standard', 'exempt', 'suspended']).default('standard'), notes: z.string().trim().max(255).nullable().optional(), isDefault: z.boolean().optional(), isActive: z.boolean().optional() };
const zeroRule = (o) => !(o.kind && o.kind !== 'standard' && o.rate !== undefined && Number(o.rate) !== 0);
const createSchema = z.object(base).refine(zeroRule, { message: 'Un taux exonéré ou suspendu doit être à 0', path: ['rate'] });
const updateSchema = asPatch(z.object(base).partial().refine((o) => Object.values(o).some((x) => x !== undefined), 'Aucune modification').refine(zeroRule, { message: 'Un taux exonéré ou suspendu doit être à 0', path: ['rate'] }));
const idParam = z.object({ id: z.string().uuid() });

const router = Router();
router.use(authenticate);

router.get('/', requirePermission('tax_rate.read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM tax_rates WHERE company_id = ? ORDER BY is_active DESC, rate DESC, name ASC', [req.auth.companyId]);
  res.json({ data: rows.map(dto) });
}));

async function load(conn, companyId, publicId) {
  const [[row]] = await conn.query('SELECT * FROM tax_rates WHERE company_id = ? AND public_id = ? FOR UPDATE', [companyId, publicId]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Taux introuvable');
  return row;
}

router.post('/', requirePermission('tax_rate.write'), validate({ body: createSchema }), asyncHandler(async (req, res) => {
  const b = req.body; const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM tax_rates WHERE company_id = ? AND is_default = 1 FOR UPDATE', [req.auth.companyId]);
    const makeDefault = b.isDefault === true || n === 0;
    if (makeDefault) await conn.query('UPDATE tax_rates SET is_default = 0 WHERE company_id = ?', [req.auth.companyId]);
    await conn.query('INSERT INTO tax_rates (public_id, company_id, name, rate, kind, is_default, is_active, notes) VALUES (?,?,?,?,?,?,?,?)',
      [publicId, req.auth.companyId, b.name, b.rate, b.kind, makeDefault ? 1 : 0, b.isActive === false ? 0 : 1, b.notes ?? null]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'tax_rate.create', entityType: 'tax_rates', entityId: publicId, ip: req.ip, meta: { name: b.name, rate: b.rate } });
  });
  const [[row]] = await pool.query('SELECT * FROM tax_rates WHERE public_id = ?', [publicId]);
  res.status(201).json({ data: dto(row) });
}));

router.patch('/:id', requirePermission('tax_rate.write'), validate({ params: idParam, body: updateSchema }), asyncHandler(async (req, res) => {
  const b = req.body;
  await withTransaction(async (conn) => {
    const row = await load(conn, req.auth.companyId, req.params.id);
    const kind = b.kind ?? row.kind; const newRate = b.rate ?? row.rate;
    if (kind !== 'standard' && Number(newRate) !== 0) throw new HttpError(422, 'INVALID_RATE', 'Un taux exonéré ou suspendu doit être à 0');
    if (b.isDefault === false && row.is_default) throw new HttpError(422, 'DEFAULT_REQUIRED', 'Choisissez un autre taux par défaut plutôt que de retirer celui-ci');
    if (b.isActive === false && (row.is_default && b.isDefault !== false)) throw new HttpError(422, 'DEFAULT_REQUIRED', 'Le taux par défaut ne peut pas être désactivé');
    if (b.isDefault === true) {
      if ((b.isActive ?? !!row.is_active) === false) throw new HttpError(422, 'INACTIVE_DEFAULT', 'Un taux inactif ne peut pas être par défaut');
      await conn.query('UPDATE tax_rates SET is_default = 0 WHERE company_id = ?', [req.auth.companyId]);
    }
    const map = { name: b.name, rate: b.rate, kind: b.kind, notes: b.notes, is_default: b.isDefault === undefined ? undefined : (b.isDefault ? 1 : 0), is_active: b.isActive === undefined ? undefined : (b.isActive ? 1 : 0) };
    const entries = Object.entries(map).filter(([, v]) => v !== undefined);
    await conn.query(`UPDATE tax_rates SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...entries.map(([, v]) => v), row.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'tax_rate.update', entityType: 'tax_rates', entityId: row.public_id, ip: req.ip, meta: { from: { rate: row.rate, active: !!row.is_active }, fields: Object.keys(b) } });
  });
  const [[row]] = await pool.query('SELECT * FROM tax_rates WHERE public_id = ? AND company_id = ?', [req.params.id, req.auth.companyId]);
  res.json({ data: dto(row) });
}));

router.delete('/:id', requirePermission('tax_rate.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const row = await load(conn, req.auth.companyId, req.params.id);
    if (row.is_default) throw new HttpError(422, 'DEFAULT_REQUIRED', 'Le taux par défaut ne peut pas être supprimé');
    await conn.query('DELETE FROM tax_rates WHERE id = ?', [row.id]); // FK produits -> 409 IN_USE
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'tax_rate.delete', entityType: 'tax_rates', entityId: row.public_id, ip: req.ip, meta: { name: row.name } });
  });
  res.status(204).end();
}));

export default router;
