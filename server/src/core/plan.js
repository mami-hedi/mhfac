// Abonnement SaaS : plan de l'entreprise, consommation, et vérification des limites CÔTÉ SERVEUR.
// Aucun prix ni limite n'est codé ici : tout vient des tables subscription_plans / company_subscriptions.
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

export const LIMIT_KEYS = ['users', 'invoicesPerMonth', 'warehouses', 'scansPerMonth', 'exportsPerMonth'];
export const FEATURE_KEYS = ['einvoice', 'purchaseScan', 'reportsExport'];
export const LIMIT_LABELS = { users: 'utilisateurs', invoicesPerMonth: 'factures émises ce mois-ci', warehouses: 'entrepôts', scansPerMonth: 'scans de factures ce mois-ci', exportsPerMonth: 'exports de rapports ce mois-ci' };
export const FEATURE_LABELS = { einvoice: 'Facturation électronique', purchaseScan: 'Scan de factures fournisseur', reportsExport: 'Export des rapports (CSV, Excel, PDF)' };
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});
const monthStart = () => `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date()).slice(0, 7)}-01 00:00:00`;

// Statut effectif : un essai ou une période échus passent en « expired » (lecture seule).
export function effectiveStatus(row, now = new Date()) {
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'trial' && row.trial_ends_at && new Date(row.trial_ends_at) < now) return 'expired';
  if ((row.status === 'active' || row.status === 'past_due') && row.current_period_end && new Date(row.current_period_end) < now) return 'expired';
  return row.status;
}
export const isReadOnly = (status) => status === 'expired' || status === 'cancelled';

// Attribue le plan voulu (par défaut DEFAULT_PLAN_CODE) à une entreprise sans abonnement : idempotent.
export async function ensureSubscription(conn, companyId, planCode = env.DEFAULT_PLAN_CODE) {
  const days = env.TRIAL_DAYS;
  if (days > 0) {
    // Essai gratuit : fin = dernier instant (heure de Tunis) du jour J+days, comme les dates saisies par l'administrateur.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    await conn.query(`INSERT IGNORE INTO company_subscriptions (company_id, plan_id, status, trial_ends_at, notes)
      SELECT ?, id, 'trial', ?, ? FROM subscription_plans WHERE code = ?`, [companyId, `${end} 23:59:59`, `Essai gratuit de ${days} jours à l'inscription`, planCode]);
  } else {
    await conn.query(`INSERT IGNORE INTO company_subscriptions (company_id, plan_id, status, notes)
      SELECT ?, id, 'active', 'Plan par défaut à l''inscription' FROM subscription_plans WHERE code = ?`, [companyId, planCode]);
  }
}

export async function getSubscription(conn, companyId, { forUpdate = false } = {}) {
  let [[r]] = await conn.query(`SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.description AS plan_description, p.price_monthly, p.price_yearly, p.currency AS plan_currency, p.limits, p.features
    FROM company_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.company_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId]);
  if (!r) {
    await ensureSubscription(conn, companyId);
    [[r]] = await conn.query(`SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.description AS plan_description, p.price_monthly, p.price_yearly, p.currency AS plan_currency, p.limits, p.features
      FROM company_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.company_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId]);
  }
  if (!r) throw new HttpError(500, 'NO_PLAN', 'Aucun plan par défaut configuré : contactez l\'administrateur');
  return { ...r, limits: parse(r.limits), features: parse(r.features), status_effective: effectiveStatus(r) };
}

export async function getUsage(conn, companyId) {
  const ms = monthStart();
  const [[u]] = await conn.query(`SELECT
    (SELECT COUNT(*) FROM company_members WHERE company_id = ? AND status IN ('active','invited')) AS members,
    (SELECT COUNT(*) FROM invitations WHERE company_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()) AS pending,
    (SELECT COUNT(*) FROM invoices WHERE company_id = ? AND kind = 'invoice' AND status IN ('issued','cancelled') AND issued_at >= ?) AS invoices,
    (SELECT COUNT(*) FROM warehouses WHERE company_id = ? AND status = 'active') AS warehouses,
    (SELECT COUNT(*) FROM purchase_scans WHERE company_id = ? AND created_at >= ?) AS scans,
    (SELECT COUNT(*) FROM audit_logs WHERE company_id = ? AND action = 'report.export' AND created_at >= ?) AS exports`,
    [companyId, companyId, companyId, ms, companyId, companyId, ms, companyId, ms]);
  return { users: Number(u.members) + Number(u.pending), invoicesPerMonth: Number(u.invoices), warehouses: Number(u.warehouses), scansPerMonth: Number(u.scans), exportsPerMonth: Number(u.exports) };
}

// Jours d'essai restants (jour de Tunis ; 0 le dernier jour, null hors essai).
const trialDaysLeft = (s) => {
  if (s.status !== 'trial' || !s.trial_ends_at || s.status_effective !== 'trial') return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
  const end = s.trial_ends_at instanceof Date ? s.trial_ends_at.toISOString().slice(0, 10) : String(s.trial_ends_at).slice(0, 10); // date calendaire saisie (stockée en UTC)
  return Math.max(0, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000));
};
// « Mois offerts » du tarif annuel (information d'affichage, calculée à partir des deux prix en base).
export const yearlyMonthsFree = (monthly, yearly) => (monthly != null && yearly != null && Number(monthly) > 0 ? Math.max(0, Math.round((12 - Number(yearly) / Number(monthly)) * 10) / 10) : null);

export const subscriptionDto = (s, usage) => ({
  plan: { code: s.plan_code, name: s.plan_name, description: s.plan_description, priceMonthly: s.price_monthly, priceYearly: s.price_yearly ?? null, yearlyMonthsFree: yearlyMonthsFree(s.price_monthly, s.price_yearly), currency: s.plan_currency },
  status: s.status, effectiveStatus: s.status_effective, readOnly: isReadOnly(s.status_effective), trialEndsAt: s.trial_ends_at, trialDaysLeft: trialDaysLeft(s), currentPeriodEnd: s.current_period_end, billingPeriod: s.billing_period ?? null,
  limits: s.limits, features: s.features, usage: usage ?? null,
});

// Lève 403 PLAN_LIMIT_REACHED si l'ajout de `increment` dépasse la limite du plan. Sur une connexion de transaction, la ligne d'abonnement est verrouillée
// (deux émissions simultanées ne peuvent pas dépasser la limite).
export async function assertLimit(conn, companyId, key, increment = 1) {
  const s = await getSubscription(conn, companyId, { forUpdate: conn !== pool });
  const limit = s.limits[key];
  if (limit === null || limit === undefined) return;
  const used = (await getUsage(conn, companyId))[key];
  if (used + increment > Number(limit)) throw new HttpError(403, 'PLAN_LIMIT_REACHED', `Limite du plan « ${s.plan_name} » atteinte : ${limit} ${LIMIT_LABELS[key]}. Passez à une offre supérieure pour continuer.`, { limit: key, max: Number(limit), used, plan: s.plan_code });
}
export async function assertFeature(conn, companyId, feature) {
  const s = await getSubscription(conn, companyId);
  if (!s.features[feature]) throw new HttpError(403, 'FEATURE_NOT_IN_PLAN', `« ${FEATURE_LABELS[feature]} » n'est pas incluse dans le plan « ${s.plan_name} ». Passez à une offre supérieure.`, { feature, plan: s.plan_code });
}
export const requireFeature = (feature) => {
  const mw = async (req, _res, next) => { try { await assertFeature(pool, req.auth.companyId, feature); next(); } catch (e) { next(e); } };
  mw.requiredFeature = feature; // lu par scripts/gen-api-docs.js
  return mw;
};
