// Données PUBLIQUES (sans connexion) pour la page d'accueil : uniquement les offres actives et publiques.
// Aucune donnée d'entreprise, aucun utilisateur : seulement ce que l'administrateur a choisi de publier (nom, prix, limites, options).
import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { yearlyMonthsFree } from '../../core/plan.js';

const router = Router();
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

router.get('/plans', asyncHandler(async (_req, res) => {
  const [rows] = await pool.query('SELECT code, name, description, price_monthly, price_yearly, currency, limits, features FROM subscription_plans WHERE is_public = 1 AND is_active = 1 ORDER BY sort_order, id');
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ data: rows.map((p) => ({ code: p.code, name: p.name, description: p.description, priceMonthly: p.price_monthly, priceYearly: p.price_yearly, yearlyMonthsFree: yearlyMonthsFree(p.price_monthly, p.price_yearly), currency: p.currency, limits: parse(p.limits), features: parse(p.features) })) });
}));
export default router;
