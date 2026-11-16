// Notifications de l'utilisateur connecté. Tout est filtré par (entreprise de la session, utilisateur de la session) : on ne peut ni lire
// ni marquer comme lue la notification d'un autre utilisateur ou d'une autre entreprise (introuvable → 404).
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { CATEGORIES, TYPES, allowedTypes, disabledTypes, visibleTypes, scanCompanyThrottled } from './notifications.service.js';

const router = Router();
router.use(authenticate);

const dto = (r) => ({ id: r.public_id, type: r.type, category: TYPES[r.type]?.category ?? null, severity: r.severity, title: r.title, body: r.body, link: r.link, read: r.read_at != null, createdAt: new Date(r.created_at).toISOString() });
const COLS = 'public_id, type, severity, title, body, link, read_at, created_at';
const unreadCount = async (auth, types) => {
  if (!types.length) return 0;
  const [[r]] = await pool.query('SELECT COUNT(*) n FROM notifications WHERE company_id = ? AND user_id = ? AND read_at IS NULL AND type IN (?)', [auth.companyId, auth.userId, types]);
  return r.n;
};

// Compteur + 6 dernières : interrogé par la cloche. Déclenche (au plus toutes les 5 min) l'analyse de l'entreprise.
router.get('/summary', asyncHandler(async (req, res) => {
  await scanCompanyThrottled(req.auth.companyId);
  const types = await visibleTypes(req.auth);
  const [rows] = types.length ? await pool.query(`SELECT ${COLS} FROM notifications WHERE company_id = ? AND user_id = ? AND type IN (?) ORDER BY created_at DESC, id DESC LIMIT 6`, [req.auth.companyId, req.auth.userId, types]) : [[]];
  res.json({ data: { unread: await unreadCount(req.auth, types), latest: rows.map(dto) } });
}));

const listQuery = z.object({ status: z.enum(['all', 'unread']).default('all'), limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });
router.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  await scanCompanyThrottled(req.auth.companyId);
  const { status, limit, offset } = req.query; const types = await visibleTypes(req.auth);
  if (!types.length) return res.json({ data: [], meta: { total: 0, unread: 0 } });
  const where = `company_id = ? AND user_id = ? AND type IN (?)${status === 'unread' ? ' AND read_at IS NULL' : ''}`; const args = [req.auth.companyId, req.auth.userId, types];
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM notifications WHERE ${where}`, args);
  const [rows] = await pool.query(`SELECT ${COLS} FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  res.json({ data: rows.map(dto), meta: { total, unread: await unreadCount(req.auth, types), limit, offset } });
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  const [r] = await pool.query('UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE company_id = ? AND user_id = ? AND read_at IS NULL', [req.auth.companyId, req.auth.userId]);
  res.json({ data: { updated: r.affectedRows } });
}));

// --- Préférences (par utilisateur et par entreprise) : seuls les types que le rôle permet de recevoir sont proposés ---
router.get('/preferences', asyncHandler(async (req, res) => {
  const off = new Set(await disabledTypes(req.auth.companyId, req.auth.userId));
  const list = allowedTypes(req.auth.permissions).map((t) => ({ type: t, category: TYPES[t].category, categoryLabel: CATEGORIES[TYPES[t].category], label: TYPES[t].label, enabled: !off.has(t) }));
  res.json({ data: list, meta: { channels: ['in_app'], note: 'Les notifications s\'affichent dans l\'application (cloche). Aucun envoi par e-mail ou WhatsApp.' } });
}));
const prefBody = z.object({ preferences: z.record(z.string(), z.boolean()).refine((o) => Object.values(o).some((x) => x !== undefined), 'Aucune préférence') }).strict();
router.put('/preferences', validate({ body: prefBody }), asyncHandler(async (req, res) => {
  const allowed = new Set(allowedTypes(req.auth.permissions));
  const bad = Object.keys(req.body.preferences).filter((t) => !allowed.has(t));
  if (bad.length) throw new HttpError(422, 'VALIDATION_ERROR', `Type de notification inconnu ou non disponible pour votre rôle : ${bad.join(', ')}`);
  for (const [type, enabled] of Object.entries(req.body.preferences)) {
    await pool.query('INSERT INTO notification_preferences (company_id, user_id, type, enabled) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [req.auth.companyId, req.auth.userId, type, enabled ? 1 : 0]);
  }
  const off = new Set(await disabledTypes(req.auth.companyId, req.auth.userId));
  res.json({ data: [...allowed].map((t) => ({ type: t, enabled: !off.has(t) })) });
}));

router.post('/:id/read', asyncHandler(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Notification introuvable');
  const [r] = await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP()) WHERE public_id = ? AND company_id = ? AND user_id = ?', [req.params.id, req.auth.companyId, req.auth.userId]);
  if (!r.affectedRows) throw new HttpError(404, 'NOT_FOUND', 'Notification introuvable');
  res.json({ data: { id: req.params.id, read: true } });
}));

export default router;
