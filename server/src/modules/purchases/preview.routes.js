import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { preparePurchase, purchaseBase } from './common.js';

// Aperçu des totaux d'un document d'achat, calculés PAR LE SERVEUR (aucune écriture).
const router = Router();
router.use(authenticate);
router.post('/preview', validate({ body: z.object(purchaseBase) }), asyncHandler(async (req, res) => {
  if (!req.auth.permissions.has('purchase.write')) throw new HttpError(403, 'FORBIDDEN', 'Permission insuffisante');
  const conn = await pool.getConnection();
  try {
    const p = await preparePurchase(conn, req.auth, req.body);
    res.json({ data: { ...p.calc, currency: p.currency, withholdingPct: p.withholdingPct, lines: p.calc.lines.map((l, i) => ({ ...l, description: p.lines[i].description, unitPrice: p.lines[i].unitPrice, unit: p.lines[i].unit, taxName: p.lines[i].taxName })) } });
  } finally { conn.release(); }
}));
export default router;
