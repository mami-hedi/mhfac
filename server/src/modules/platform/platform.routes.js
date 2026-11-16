// Espace super administrateur : entreprises, offres, abonnements, limites et état général de la plateforme.
// Toutes les actions sont journalisées. Aucune donnée métier (factures, clients, stock…) n'est exposée ici : uniquement compteurs et configuration.
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { listQuerySchema, escapeLike } from '../../core/list.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticatePlatform } from '../../middlewares/platformAuth.js';
import { validate } from '../../middlewares/validate.js';
import { loadPaymentInfo, adminPaymentInfo, listPayments, confirmPayment, rejectPayment, checkIban, checkBic } from '../subscription/payments.service.js';
import { LIMIT_KEYS, effectiveStatus, getSubscription, getUsage, subscriptionDto, yearlyMonthsFree } from '../../core/plan.js';

const router = Router();
router.use(authenticatePlatform);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const uuid = z.string().uuid();
const lim = z.number().int().min(0).max(1_000_000).nullable();
const limitsSchema = z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, lim]))).strict();
const featuresSchema = z.object({ einvoice: z.boolean(), purchaseScan: z.boolean(), reportsExport: z.boolean(), support: z.string().trim().max(100).optional() }).strict();
const planBody = z.object({
  name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).nullable().optional(),
  priceMonthly: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, 'Prix invalide').nullable().optional(), priceYearly: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, 'Prix invalide').nullable().optional(), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('TND'),
  limits: limitsSchema, features: featuresSchema, isActive: z.boolean().default(true), isPublic: z.boolean().default(true), sortOrder: z.number().int().min(0).max(10000).default(0),
});
const planDto = (p, companies) => ({ id: p.id, code: p.code, name: p.name, description: p.description, priceMonthly: p.price_monthly, priceYearly: p.price_yearly, yearlyMonthsFree: yearlyMonthsFree(p.price_monthly, p.price_yearly), currency: p.currency, limits: parse(p.limits), features: parse(p.features), isActive: !!p.is_active, isPublic: !!p.is_public, sortOrder: p.sort_order, companies: companies ?? undefined });

router.get('/overview', asyncHandler(async (_req, res) => {
  const [[t]] = await pool.query(`SELECT (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM companies WHERE status = 'suspended') AS suspended,
    (SELECT COUNT(*) FROM users WHERE status = 'active') AS users, (SELECT COUNT(*) FROM invoices WHERE kind = 'invoice' AND status = 'issued') AS invoices,
    (SELECT COUNT(*) FROM companies WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY) AS new30,
    (SELECT COUNT(*) FROM subscription_payments WHERE status = 'pending') AS pending_payments`);
  const [byPlan] = await pool.query('SELECT p.code, p.name, COUNT(s.company_id) AS n FROM subscription_plans p LEFT JOIN company_subscriptions s ON s.plan_id = p.id GROUP BY p.id ORDER BY p.sort_order, p.id');
  const [byStatus] = await pool.query('SELECT status, COUNT(*) AS n FROM company_subscriptions GROUP BY status');
  const [[mig]] = await pool.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
  // À traiter : virements déclarés en attente, et entreprises dont l'échéance tombe dans les 7 prochains jours ou vient de passer (30 jours).
  const [pending] = await pool.query(`SELECT sp.public_id, sp.amount, sp.currency, sp.period, sp.reference, DATE_FORMAT(sp.paid_on,'%Y-%m-%d') AS paid_on_s, sp.created_at, c.name AS company_name, c.public_id AS company_pid, p.name AS plan_name
    FROM subscription_payments sp JOIN companies c ON c.id = sp.company_id JOIN subscription_plans p ON p.id = sp.plan_id WHERE sp.status = 'pending' ORDER BY sp.id LIMIT 50`);
  const [due] = await pool.query(`SELECT c.name, c.public_id, p.name AS plan_name, s.status, IF(s.status = 'trial', s.trial_ends_at, s.current_period_end) AS due
    FROM company_subscriptions s JOIN companies c ON c.id = s.company_id JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.status IN ('trial','active','past_due') AND c.status = 'active' AND IF(s.status = 'trial', s.trial_ends_at, s.current_period_end) BETWEEN UTC_TIMESTAMP() - INTERVAL 30 DAY AND UTC_TIMESTAMP() + INTERVAL 7 DAY
    ORDER BY (due < UTC_TIMESTAMP()), IF(due < UTC_TIMESTAMP(), -UNIX_TIMESTAMP(due), UNIX_TIMESTAMP(due)) LIMIT 100`); // d'abord les échéances à venir (la plus proche en tête), puis les dépassées (la plus récente en tête)
  const now = new Date();
  const [[exp]] = await pool.query(`SELECT COUNT(*) AS n FROM company_subscriptions WHERE (status = 'trial' AND trial_ends_at < UTC_TIMESTAMP()) OR (status IN ('active','past_due') AND current_period_end < UTC_TIMESTAMP())`);
  res.json({ data: { toProcess: { payments: pending.map((r) => ({ id: r.public_id, company: { id: r.company_pid, name: r.company_name }, plan: r.plan_name, period: r.period, amount: r.amount, currency: r.currency, reference: r.reference, paidOn: r.paid_on_s, declaredAt: r.created_at })),
    dueSoon: due.map((r) => ({ company: { id: r.public_id, name: r.name }, plan: r.plan_name, status: r.status, dueDate: r.due, expired: new Date(r.due) < now })) }, expiredSubscriptions: Number(exp.n),
    companies: Number(t.companies), suspendedCompanies: Number(t.suspended), activeUsers: Number(t.users), invoicesIssued: Number(t.invoices), newCompanies30d: Number(t.new30), pendingPayments: Number(t.pending_payments),
    byPlan: byPlan.map((p) => ({ code: p.code, name: p.name, count: Number(p.n) })), bySubscriptionStatus: Object.fromEntries(byStatus.map((s) => [s.status, Number(s.n)])), health: { database: 'up', tables: Number(mig.n) } } });
}));

router.get('/plans', asyncHandler(async (_req, res) => {
  const [rows] = await pool.query('SELECT p.*, (SELECT COUNT(*) FROM company_subscriptions s WHERE s.plan_id = p.id) AS n FROM subscription_plans p ORDER BY p.sort_order, p.id');
  res.json({ data: rows.map((p) => planDto(p, Number(p.n))), meta: { limitKeys: LIMIT_KEYS } });
}));
router.post('/plans', validate({ body: planBody.extend({ code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,38}$/, 'Code : lettres minuscules, chiffres et _') }) }), asyncHandler(async (req, res) => {
  const b = req.body; const [[dup]] = await pool.query('SELECT 1 AS x FROM subscription_plans WHERE code = ?', [b.code]);
  if (dup) throw new HttpError(409, 'DUPLICATE', 'Ce code d\'offre existe déjà');
  const [r] = await pool.query('INSERT INTO subscription_plans (code, name, description, price_monthly, price_yearly, currency, limits, features, is_active, is_public, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [b.code, b.name, b.description ?? null, b.priceMonthly ?? null, b.priceYearly ?? null, b.currency, JSON.stringify(b.limits), JSON.stringify(b.features), b.isActive ? 1 : 0, b.isPublic ? 1 : 0, b.sortOrder]);
  await audit(null, { userId: req.platform.userId, action: 'platform.plan_create', entityType: 'subscription_plans', entityId: r.insertId, ip: req.ip, meta: { code: b.code } });
  const [[p]] = await pool.query('SELECT * FROM subscription_plans WHERE id = ?', [r.insertId]); res.status(201).json({ data: planDto(p, 0) });
}));
router.put('/plans/:id', validate({ params: z.object({ id: z.coerce.number().int().positive() }), body: planBody }), asyncHandler(async (req, res) => {
  const b = req.body; const [[cur]] = await pool.query('SELECT * FROM subscription_plans WHERE id = ?', [req.params.id]);
  if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Offre introuvable');
  await pool.query('UPDATE subscription_plans SET name=?, description=?, price_monthly=?, price_yearly=?, currency=?, limits=?, features=?, is_active=?, is_public=?, sort_order=? WHERE id=?',
    [b.name, b.description ?? null, b.priceMonthly ?? null, b.priceYearly ?? null, b.currency, JSON.stringify(b.limits), JSON.stringify(b.features), b.isActive ? 1 : 0, b.isPublic ? 1 : 0, b.sortOrder, cur.id]);
  await audit(null, { userId: req.platform.userId, action: 'platform.plan_update', entityType: 'subscription_plans', entityId: cur.id, ip: req.ip, meta: { code: cur.code, from: { limits: parse(cur.limits), features: parse(cur.features), price: cur.price_monthly, priceYearly: cur.price_yearly }, to: { limits: b.limits, features: b.features, price: b.priceMonthly ?? null } } });
  const [[p]] = await pool.query('SELECT * FROM subscription_plans WHERE id = ?', [cur.id]); res.json({ data: planDto(p) });
}));

const companyRow = (c, s, u) => ({ id: c.public_id, name: c.name, taxId: c.tax_id, status: c.status, createdAt: c.created_at, ownerEmail: c.owner_email ?? null,
  plan: s ? { code: s.plan_code, name: s.plan_name } : null, subscriptionStatus: s?.status ?? null, effectiveStatus: s?.status_effective ?? null, currentPeriodEnd: s?.current_period_end ?? null, trialEndsAt: s?.trial_ends_at ?? null,
  dueDate: s ? (s.status === 'trial' ? s.trial_ends_at : s.current_period_end) ?? null : null, usage: u ?? undefined }); // dueDate : échéance utile (fin d'essai ou fin de période payée)

// --- Paiement par virement : coordonnées bancaires de l'éditeur et vérification des déclarations ---
const optText = (max) => z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(max).nullable().optional());
router.get('/payment-info', asyncHandler(async (_req, res) => { res.json({ data: adminPaymentInfo(await loadPaymentInfo()) }); }));
router.put('/payment-info', validate({ body: z.object({
  beneficiary: z.string().trim().min(2).max(150), bankName: z.string().trim().min(2).max(150),
  rib: z.string().trim().regex(/^[0-9 ]{20,30}$/, 'RIB : 20 chiffres (espaces autorisés)').refine((v) => v.replace(/ /g, '').length === 20, 'RIB : 20 chiffres'),
  iban: optText(40), bic: optText(20), contactEmail: z.preprocess((v) => (v === '' ? null : v), z.string().trim().email().max(190).nullable().optional()), contactPhone: optText(40), instructions: optText(1000),
}).strict() }), asyncHandler(async (req, res) => {
  const b = req.body;
  if (/(à compléter|a completer|^x+$)/i.test(`${b.beneficiary} ${b.bankName}`) || /^0[0 ]*$/.test(b.rib)) throw new HttpError(422, 'PLACEHOLDER_VALUES', 'Remplacez les valeurs de remplacement (« À COMPLÉTER », RIB à zéros) par vos vraies coordonnées.');
  const bad = (b.iban && checkIban(b.iban, b.rib)) || (b.bic && checkBic(b.bic));
  if (bad) throw new HttpError(422, 'INVALID_BANK_DETAILS', bad);
  await pool.query('UPDATE platform_payment_info SET beneficiary=?, bank_name=?, rib=?, iban=?, bic=?, contact_email=?, contact_phone=?, instructions=?, is_configured=1, updated_by=? WHERE id=1',
    [b.beneficiary, b.bankName, b.rib, b.iban ? b.iban.replace(/ /g, '').toUpperCase() : null, b.bic ? b.bic.toUpperCase() : null, b.contactEmail ?? null, b.contactPhone ?? null, b.instructions ?? null, req.platform.userId]);
  await audit(null, { userId: req.platform.userId, action: 'platform.payment_info_update', entityType: 'platform_payment_info', entityId: '1', ip: req.ip, meta: { bankName: b.bankName } }); // le RIB complet n'est pas copié dans le journal
  res.json({ data: adminPaymentInfo(await loadPaymentInfo()) });
}));
router.get('/payments', validate({ query: z.object({ status: z.enum(['pending', 'confirmed', 'rejected']).optional() }) }), asyncHandler(async (req, res) => {
  res.json({ data: await listPayments({ status: req.query.status ?? null }) });
}));
const amountStr = z.union([z.string(), z.number()]).transform((v) => String(v).trim().replace(',', '.')).refine((v) => /^\d{1,12}(\.\d{1,3})?$/.test(v) && Number(v) > 0, 'Montant positif (3 décimales max)');
router.post('/payments/:id/confirm', validate({ params: z.object({ id: uuid }), body: z.object({ receivedAmount: amountStr, note: optText(500) }).strict() }), asyncHandler(async (req, res) => {
  res.json({ data: await confirmPayment(req.platform.userId, req.ip, req.params.id, req.body) });
}));
router.post('/payments/:id/reject', validate({ params: z.object({ id: uuid }), body: z.object({ reason: z.string().trim().min(5, 'Motif trop court (5 caractères min.)').max(500) }).strict() }), asyncHandler(async (req, res) => {
  res.json({ data: await rejectPayment(req.platform.userId, req.ip, req.params.id, req.body) });
}));

router.get('/companies', validate({ query: listQuerySchema.omit({ status: true }).extend({ status: z.enum(['active', 'suspended']).optional(), plan: z.string().max(40).optional(), subscription: z.enum(['trial', 'active', 'expired', 'expiring', 'past_due', 'cancelled']).optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['1=1']; const params = [];
  if (q.status) { where.push('c.status = ?'); params.push(q.status); }
  if (q.plan) { where.push('p.code = ?'); params.push(q.plan); }
  // Filtre « abonnement » : mêmes règles que effectiveStatus() (un essai ou une période échus sont « expirés »).
  const EXPIRED = "((s.status = 'trial' AND s.trial_ends_at < UTC_TIMESTAMP()) OR (s.status IN ('active','past_due') AND s.current_period_end < UTC_TIMESTAMP()))";
  const SUBF = { expired: EXPIRED, trial: `(s.status = 'trial' AND NOT ${EXPIRED})`, active: `(s.status = 'active' AND NOT ${EXPIRED})`, past_due: `(s.status = 'past_due' AND NOT ${EXPIRED})`, cancelled: "s.status = 'cancelled'",
    expiring: `(s.status IN ('trial','active','past_due') AND NOT ${EXPIRED} AND IF(s.status = 'trial', s.trial_ends_at, s.current_period_end) <= UTC_TIMESTAMP() + INTERVAL 7 DAY)` };
  if (q.subscription) where.push(SUBF[q.subscription]);
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(c.name LIKE ? OR c.tax_id LIKE ?)'); params.push(like, like); }
  const w = where.join(' AND ');
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM companies c LEFT JOIN company_subscriptions s ON s.company_id = c.id LEFT JOIN subscription_plans p ON p.id = s.plan_id WHERE ${w}`, params);
  const [rows] = await pool.query(`SELECT c.*, p.code AS plan_code, p.name AS plan_name, s.status AS sub_status, s.current_period_end, s.trial_ends_at,
      (SELECT u.email FROM company_members cm JOIN users u ON u.id = cm.user_id JOIN roles r ON r.id = cm.role_id WHERE cm.company_id = c.id AND r.code = 'owner' ORDER BY cm.id LIMIT 1) AS owner_email
    FROM companies c LEFT JOIN company_subscriptions s ON s.company_id = c.id LEFT JOIN subscription_plans p ON p.id = s.plan_id WHERE ${w} ORDER BY ${q.subscription === 'expiring' || q.subscription === 'expired' ? 'IF(s.status = \'trial\', s.trial_ends_at, s.current_period_end), ' : ''}c.id DESC LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
  res.json({ data: rows.map((c) => companyRow(c, c.plan_code ? { plan_code: c.plan_code, plan_name: c.plan_name, status: c.sub_status, current_period_end: c.current_period_end, trial_ends_at: c.trial_ends_at, status_effective: effectiveStatus({ status: c.sub_status, current_period_end: c.current_period_end, trial_ends_at: c.trial_ends_at }) } : null)), meta: { total, page: q.page, limit: q.limit } });
}));

const loadCompany = async (conn, publicId, forUpdate = false) => {
  const [[c]] = await conn.query(`SELECT * FROM companies WHERE public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [publicId]);
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'Entreprise introuvable');
  return c;
};
router.get('/companies/:id', validate({ params: z.object({ id: uuid }) }), asyncHandler(async (req, res) => {
  const c = await loadCompany(pool, req.params.id);
  const [s, usage] = await Promise.all([getSubscription(pool, c.id), getUsage(pool, c.id)]);
  const [events] = await pool.query('SELECT e.event, e.detail, e.created_at, u.email AS by_email FROM subscription_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.company_id = ? ORDER BY e.id DESC LIMIT 30', [c.id]);
  const [members] = await pool.query(`SELECT u.email, u.full_name, r.code AS role, cm.status FROM company_members cm JOIN users u ON u.id = cm.user_id JOIN roles r ON r.id = cm.role_id WHERE cm.company_id = ? ORDER BY cm.id`, [c.id]);
  res.json({ data: { ...companyRow(c, s, usage), subscription: subscriptionDto(s, usage), notes: s.notes, members: members.map((m) => ({ email: m.email, fullName: m.full_name, role: m.role, status: m.status })),
    history: events.map((e) => ({ event: e.event, detail: parse(e.detail), at: e.created_at, by: e.by_email })) } });
}));

const dt = z.preprocess((v) => (v === '' ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ').nullable().optional());
router.put('/companies/:id/subscription', validate({ params: z.object({ id: uuid }), body: z.object({ planCode: z.string().max(40), status: z.enum(['trial', 'active', 'past_due', 'cancelled']), billingPeriod: z.enum(['monthly', 'yearly']).nullable().optional(), trialEndsAt: dt, currentPeriodEnd: dt, notes: z.string().trim().max(500).nullable().optional() }) }), asyncHandler(async (req, res) => {
  const b = req.body;
  await withTransaction(async (conn) => {
    const c = await loadCompany(conn, req.params.id, true);
    const [[plan]] = await conn.query('SELECT * FROM subscription_plans WHERE code = ?', [b.planCode]);
    if (!plan) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Offre inconnue');
    const before = await getSubscription(conn, c.id, { forUpdate: true });
    if (plan.id !== before.plan_id && !plan.is_active) throw new HttpError(422, 'PLAN_INACTIVE', 'Cette offre n\'est plus attribuable');
    if (b.status === 'trial' && !b.trialEndsAt) throw new HttpError(422, 'TRIAL_END_REQUIRED', 'Date de fin d\'essai requise');
    // un plan plus restrictif est refusé si la consommation actuelle dépasse déjà ses limites (évite un état incohérent) : l'admin doit d'abord le constater
    const usage = await getUsage(conn, c.id); const nl = parse(plan.limits); const over = LIMIT_KEYS.filter((k) => k !== 'invoicesPerMonth' && k !== 'scansPerMonth' && k !== 'exportsPerMonth' && nl[k] != null && usage[k] > nl[k]);
    if (over.length) throw new HttpError(409, 'USAGE_EXCEEDS_PLAN', `La consommation actuelle dépasse les limites de cette offre (${over.map((k) => `${k} : ${usage[k]} > ${nl[k]}`).join(', ')}).`, { exceeded: over });
    await conn.query('UPDATE company_subscriptions SET trial_reminder_sent_at = IF(? = \'trial\' AND (trial_ends_at IS NULL OR trial_ends_at <> ?), NULL, trial_reminder_sent_at), plan_id = ?, status = ?, trial_ends_at = ?, current_period_end = ?, billing_period = ?, notes = ?, updated_by = ? WHERE company_id = ?',
      [b.status, b.trialEndsAt ? `${b.trialEndsAt} 23:59:59` : null, plan.id, b.status, b.trialEndsAt ? `${b.trialEndsAt} 23:59:59` : null, b.currentPeriodEnd ? `${b.currentPeriodEnd} 23:59:59` : null, b.billingPeriod ?? null, b.notes ?? null, req.platform.userId, c.id]);
    const detail = { from: { plan: before.plan_code, status: before.status, periodEnd: before.current_period_end }, to: { plan: plan.code, status: b.status, periodEnd: b.currentPeriodEnd ?? null, billingPeriod: b.billingPeriod ?? null } };
    await conn.query('INSERT INTO subscription_events (company_id, event, detail, created_by) VALUES (?,?,?,?)', [c.id, plan.id !== before.plan_id ? 'plan_changed' : 'subscription_updated', JSON.stringify(detail), req.platform.userId]);
    await audit(conn, { companyId: c.id, userId: req.platform.userId, action: 'platform.subscription_update', entityType: 'company_subscriptions', entityId: c.public_id, ip: req.ip, meta: detail });
  });
  const c = await loadCompany(pool, req.params.id); const s = await getSubscription(pool, c.id);
  res.json({ data: subscriptionDto(s, await getUsage(pool, c.id)) });
}));

const setCompanyStatus = (status, action) => asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const c = await loadCompany(conn, req.params.id, true);
    if (c.status === status) throw new HttpError(409, 'INVALID_TRANSITION', status === 'suspended' ? 'Entreprise déjà suspendue' : 'Entreprise déjà active');
    await conn.query('UPDATE companies SET status = ? WHERE id = ?', [status, c.id]);
    await conn.query('INSERT INTO subscription_events (company_id, event, detail, created_by) VALUES (?,?,?,?)', [c.id, action, JSON.stringify({ reason: req.body.reason }), req.platform.userId]);
    await audit(conn, { companyId: c.id, userId: req.platform.userId, action: `platform.company_${action}`, entityType: 'companies', entityId: c.public_id, ip: req.ip, meta: { reason: req.body.reason } });
  });
  res.status(204).end();
});
const reasonBody = z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) });
router.post('/companies/:id/suspend', validate({ params: z.object({ id: uuid }), body: reasonBody }), setCompanyStatus('suspended', 'suspended'));
router.post('/companies/:id/reactivate', validate({ params: z.object({ id: uuid }), body: reasonBody }), setCompanyStatus('active', 'reactivated'));
export default router;
