import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { bodyBase, prepare } from './common.js';
import { renderDocumentPdf } from './pdf.js';
import { frameFields } from '../companies/settings.js';
import { sampleDocument } from './sample-doc.js';

// Aperçu des totaux calculés PAR LE SERVEUR (aucune écriture) : l'interface n'additionne jamais elle-même.
const router = Router();
router.use(authenticate);
router.post('/preview', validate({ body: z.object(bodyBase) }), asyncHandler(async (req, res) => {
  if (!['quote.write', 'invoice.write'].some((p) => req.auth.permissions.has(p))) throw new HttpError(403, 'FORBIDDEN', 'Permission insuffisante');
  const conn = await pool.getConnection();
  try {
    const p = await prepare(conn, req.auth, req.body);
    res.json({ data: { ...p.calc, currency: p.currency, withholdingPct: p.withholdingPct, lines: p.calc.lines.map((l, i) => ({ ...l, description: p.lines[i].description, unitPrice: p.lines[i].unitPrice, unit: p.lines[i].unit, taxName: p.lines[i].taxName, fodec: p.lines[i].fodec })) } });
  } finally { conn.release(); }
}));

// Aperçu PDF du modèle avec un document FICTIF (couleur et langue en cours d'édition, logo enregistré) : rien n'est écrit en base.
const sampleBody = z.object({ kind: z.enum(['invoice', 'quote', 'delivery_note']).default('invoice'), accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), branding: z.object(frameFields).partial().optional() });
router.post('/sample-pdf', validate({ body: sampleBody }), asyncHandler(async (req, res) => {
  if (!req.auth.permissions.has('settings.read')) throw new HttpError(403, 'FORBIDDEN', 'Permission insuffisante');
  const { kind, accentColor, branding } = req.body;
  const buf = await renderDocumentPdf({ kind, doc: sampleDocument(kind), companyId: req.auth.companyId, accent: accentColor, branding, sample: true });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', 'inline; filename="exemple.pdf"'); res.send(buf);
}));
export default router;
