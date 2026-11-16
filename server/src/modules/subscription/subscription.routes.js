// « Mon abonnement » : plan, statut, consommation et offres disponibles. Lecture seule : aucun paiement en ligne n'est géré,
// le changement de plan est effectué par l'administrateur de la plateforme.
import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { loadPaymentInfo, publicPaymentInfo, paymentOptions, declarePayment, listPayments, PERIODS } from './payments.service.js';
import { getSubscription, getUsage, subscriptionDto, yearlyMonthsFree, FEATURE_LABELS, LIMIT_LABELS } from '../../core/plan.js';

const router = Router();
router.use(authenticate);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

router.get('/', requirePermission('subscription.read'), asyncHandler(async (req, res) => {
  const [s, usage] = await Promise.all([getSubscription(pool, req.auth.companyId), getUsage(pool, req.auth.companyId)]);
  res.json({ data: subscriptionDto(s, usage), meta: { limitLabels: LIMIT_LABELS, featureLabels: FEATURE_LABELS, paymentOnline: false, note: 'Le changement de plan est effectué par l\'administrateur de la plateforme : aucun paiement en ligne n\'est disponible.' } });
}));

router.get('/plans', requirePermission('subscription.read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT code, name, description, price_monthly, price_yearly, currency, limits, features FROM subscription_plans WHERE is_public = 1 AND is_active = 1 ORDER BY sort_order, id');
  res.json({ data: rows.map((p) => ({ code: p.code, name: p.name, description: p.description, priceMonthly: p.price_monthly, priceYearly: p.price_yearly, yearlyMonthsFree: yearlyMonthsFree(p.price_monthly, p.price_yearly), currency: p.currency, limits: parse(p.limits), features: parse(p.features) })) });
}));

// --- Paiement par virement bancaire (aucun paiement en ligne) ---
router.get('/payment-info', requirePermission('subscription.read'), asyncHandler(async (req, res) => {
  const [info, opts] = await Promise.all([loadPaymentInfo(), paymentOptions(req.auth.companyId)]);
  res.json({ data: { ...publicPaymentInfo(info), ...opts }, meta: { paymentOnline: false, note: 'Paiement par virement bancaire. L\'abonnement est activé après vérification du virement par l\'éditeur.' } });
}));
router.get('/payments', requirePermission('subscription.read'), asyncHandler(async (req, res) => {
  res.json({ data: await listPayments({ companyId: req.auth.companyId }) });
}));
const declareBody = z.object({
  period: z.enum(PERIODS),
  reference: z.string().trim().min(3, 'Référence trop courte').max(60),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'Date invalide'),
  note: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(500).nullable().optional()),
}).strict(); // aucun montant, aucune offre : tout est calculé par le serveur
router.post('/payments', requirePermission('subscription.write'), validate({ body: declareBody }), asyncHandler(async (req, res) => {
  res.status(201).json({ data: await declarePayment(req.auth, req.ip, req.body) });
}));
export default router;
