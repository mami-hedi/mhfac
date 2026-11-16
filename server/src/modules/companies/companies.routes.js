import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate, asPatch } from '../../middlewares/validate.js';
import { toCompanyDto } from '../auth/auth.service.js';
import { getSettings, saveSettings, settingsPatchSchema } from './settings.js';
import numberingRoutes from './numbering.routes.js';

const router = Router();
router.use(authenticate);

const updateSchema = z.object({
  name: z.string().trim().min(2).max(190),
  legalName: z.string().trim().max(190).nullable(),
  taxId: z.string().trim().max(50).nullable(),
  locale: z.literal('fr'),
}).partial().refine((v) => Object.values(v).some((x) => x !== undefined), 'Aucun champ à modifier');
updateSchema.__patch = true;

// L'entreprise est TOUJOURS celle de la session : pas d'identifiant d'entreprise dans l'URL.
router.get('/current', asyncHandler(async (req, res) => {
  const [[c]] = await pool.query('SELECT * FROM companies WHERE id = ?', [req.auth.companyId]);
  res.json({ data: toCompanyDto(c) });
}));

router.patch('/current', requirePermission('settings.write'), validate({ body: updateSchema }), asyncHandler(async (req, res) => {
  const map = { name: 'name', legalName: 'legal_name', taxId: 'tax_id', locale: 'locale' };
  const sets = Object.keys(req.body).map((k) => `${map[k]} = ?`);
  await pool.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`, [...Object.values(req.body), req.auth.companyId]);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'company.updated', entityType: 'company', entityId: req.auth.companyId, ip: req.ip, meta: { fields: Object.keys(req.body) } });
  const [[c]] = await pool.query('SELECT * FROM companies WHERE id = ?', [req.auth.companyId]);
  res.json({ data: toCompanyDto(c) });
}));

router.get('/current/settings', requirePermission('settings.read'), asyncHandler(async (req, res) => {
  res.json({ data: await getSettings(req.auth.companyId) });
}));

router.patch('/current/settings', requirePermission('settings.write'), validate({ body: settingsPatchSchema }), asyncHandler(async (req, res) => {
  const data = await saveSettings(req.auth.companyId, req.body);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'company.settings_updated', entityType: 'company', entityId: req.auth.companyId, ip: req.ip, meta: { sections: Object.keys(req.body), fields: Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, Object.keys(v)])) } });
  res.json({ data });
}));

router.use('/current/numbering', numberingRoutes);

export default router;
