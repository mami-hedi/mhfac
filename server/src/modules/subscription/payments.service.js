// Paiement de l'abonnement par VIREMENT BANCAIRE (aucun paiement en ligne n'existe dans MHFac).
// Flux : le client voit les coordonnées bancaires et le montant attendu -> effectue le virement -> le DÉCLARE (référence, date) ->
// l'administrateur de la plateforme vérifie son relevé, saisit le montant constaté et CONFIRME (l'abonnement est alors activé et l'échéance calculée
// par le serveur) ou REJETTE avec un motif. Rien n'est activé sur la seule déclaration du client.
import { pool, withTransaction } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { cmpMoney } from '../../core/calc.js';
import { sendMail, clientUrl } from '../../core/mailer.js';
import { env } from '../../config/env.js';
import { getSubscription, effectiveStatus, yearlyMonthsFree } from '../../core/plan.js';

export const PERIODS = ['monthly', 'yearly'];
export const tunisToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const dateOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)); // dates stockées en UTC

// Ajoute 1 mois ou 1 an à une date AAAA-MM-JJ en conservant le jour, ramené à la fin du mois si besoin (31 janv. + 1 mois = 28/29 févr.).
export function addPeriod(iso, period) {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + (period === 'yearly' ? 12 : 1), 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

// Contrôle d'un IBAN tunisien : forme TN + 22 chiffres, clé de contrôle ISO 13616 (modulo 97) et cohérence avec le RIB (les 20 derniers chiffres sont le RIB).
export function checkIban(iban, rib) {
  const v = iban.replace(/ /g, '').toUpperCase();
  if (!/^TN\d{22}$/.test(v)) return 'IBAN tunisien : « TN » suivi de 22 chiffres';
  const n = BigInt([...(v.slice(4) + v.slice(0, 4))].map((ch) => (ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch)).join(''));
  if (n % 97n !== 1n) return 'IBAN invalide (clé de contrôle incorrecte)';
  if (v.slice(4) !== rib.replace(/ /g, '')) return 'L\'IBAN ne correspond pas au RIB saisi';
  return null;
}
export const checkBic = (bic) => (/^[A-Z]{4}TN[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic.toUpperCase()) && !/^X{4}/i.test(bic) ? null : 'BIC invalide (ex. BXMPTNTT)');

export const priceFor = (plan, period) => (period === 'yearly' ? plan.price_yearly : plan.price_monthly);
export const transferReference = (companyPublicId) => `MHFAC-${companyPublicId.slice(0, 8).toUpperCase()}`;

export async function loadPaymentInfo(conn = pool) {
  const [[r]] = await conn.query('SELECT * FROM platform_payment_info WHERE id = 1');
  return r;
}
// Vue destinée aux ENTREPRISES : jamais les valeurs de remplacement tant que l'administrateur n'a pas enregistré les vraies coordonnées.
export const publicPaymentInfo = (r) => (r.is_configured
  ? { configured: true, bank: { beneficiary: r.beneficiary, bankName: r.bank_name, rib: r.rib, iban: r.iban, bic: r.bic }, contactEmail: r.contact_email, contactPhone: r.contact_phone, instructions: r.instructions }
  : { configured: false, bank: null, contactEmail: null, contactPhone: null, instructions: null });
export const adminPaymentInfo = (r) => ({ beneficiary: r.beneficiary, bankName: r.bank_name, rib: r.rib, iban: r.iban, bic: r.bic, contactEmail: r.contact_email, contactPhone: r.contact_phone, instructions: r.instructions, configured: !!r.is_configured, updatedAt: r.updated_at });

export const paymentDto = (p) => ({
  id: p.public_id, company: p.company_name ? { id: p.company_pid, name: p.company_name } : undefined, plan: { code: p.plan_code, name: p.plan_name }, period: p.period, amount: p.amount, currency: p.currency,
  reference: p.reference, paidOn: p.paid_on_s, note: p.note, status: p.status, receivedAmount: p.received_amount, reviewNote: p.review_note, reviewedAt: p.reviewed_at, periodEnd: p.period_end_s, createdAt: p.created_at,
});
const SELECT = `SELECT sp.*, DATE_FORMAT(sp.paid_on,'%Y-%m-%d') AS paid_on_s, DATE_FORMAT(sp.period_end,'%Y-%m-%d') AS period_end_s, p.code AS plan_code, p.name AS plan_name, c.name AS company_name, c.public_id AS company_pid
  FROM subscription_payments sp JOIN subscription_plans p ON p.id = sp.plan_id JOIN companies c ON c.id = sp.company_id`;
export const listPayments = async ({ companyId = null, status = null } = {}) => {
  const where = []; const args = [];
  if (companyId) { where.push('sp.company_id = ?'); args.push(companyId); }
  if (status) { where.push('sp.status = ?'); args.push(status); }
  const [rows] = await pool.query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sp.id DESC LIMIT 200`, args);
  return rows.map(paymentDto);
};
const loadPayment = async (conn, publicId, forUpdate = false) => {
  const [[p]] = await conn.query(`${SELECT} WHERE sp.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [publicId]);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Paiement introuvable');
  return p;
};

// Options de paiement de l'entreprise : montants calculés par le serveur à partir de l'offre actuelle.
export async function paymentOptions(companyId) {
  const s = await getSubscription(pool, companyId);
  const [[co]] = await pool.query('SELECT public_id FROM companies WHERE id = ?', [companyId]);
  const [[pending]] = await pool.query("SELECT COUNT(*) AS n FROM subscription_payments WHERE company_id = ? AND status = 'pending'", [companyId]);
  return {
    plan: { code: s.plan_code, name: s.plan_name }, currency: s.plan_currency, transferReference: transferReference(co.public_id), hasPending: Number(pending.n) > 0,
    options: [
      { period: 'monthly', amount: s.price_monthly },
      { period: 'yearly', amount: s.price_yearly, monthsFree: yearlyMonthsFree(s.price_monthly, s.price_yearly) },
    ].filter((o) => o.amount != null),
  };
}

export async function ownerEmails(conn, companyId) {
  const [rows] = await conn.query(`SELECT DISTINCT u.email FROM company_members cm JOIN users u ON u.id = cm.user_id JOIN roles r ON r.id = cm.role_id
    WHERE cm.company_id = ? AND r.code = 'owner' AND cm.status = 'active' AND u.status = 'active'`, [companyId]);
  return rows.map((r) => r.email);
}
async function notifyOwners(companyId, subject, text) {
  try { for (const to of await ownerEmails(pool, companyId)) await sendMail({ to, subject, text }); } catch (e) { console.error('[subscription] e-mail non envoyé :', e.message); }
}

// Alerte au propriétaire de la plateforme (best-effort : un e-mail en échec ne bloque jamais la déclaration du client).
export async function notifyPlatformOwner(subject, text) {
  try {
    const to = env.PLATFORM_ALERT_EMAIL || (await loadPaymentInfo()).contact_email;
    if (to) await sendMail({ to, subject, text });
  } catch (e) { console.error('[subscription] alerte propriétaire non envoyée :', e.message); }
}

export async function declarePayment(auth, ip, { period, reference, paidOn, note }) {
  if (paidOn > tunisToday()) throw new HttpError(422, 'FUTURE_DATE', 'La date du virement ne peut pas être dans le futur');
  const info = await loadPaymentInfo();
  if (!info.is_configured) throw new HttpError(409, 'PAYMENT_NOT_AVAILABLE', 'Les coordonnées bancaires ne sont pas encore communiquées : contactez l\'éditeur avant de payer.');
  const dto = await withTransaction(async (conn) => {
    const s = await getSubscription(conn, auth.companyId, { forUpdate: true }); // verrou : deux déclarations simultanées ne passent pas
    if (s.status === 'cancelled') throw new HttpError(409, 'SUBSCRIPTION_CANCELLED', 'Abonnement annulé : contactez l\'éditeur.');
    const amount = priceFor(s, period);
    if (amount == null) throw new HttpError(422, 'PRICE_NOT_DEFINED', 'Aucun tarif défini pour cette périodicité : contactez l\'éditeur.');
    const [[pend]] = await conn.query("SELECT COUNT(*) AS n FROM subscription_payments WHERE company_id = ? AND status = 'pending'", [auth.companyId]);
    if (Number(pend.n) > 0) throw new HttpError(409, 'PAYMENT_PENDING', 'Un paiement est déjà en attente de vérification.');
    const pid = newPublicId();
    await conn.query('INSERT INTO subscription_payments (public_id, company_id, plan_id, period, amount, currency, reference, paid_on, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [pid, auth.companyId, s.plan_id, period, amount, s.plan_currency, reference, paidOn, note ?? null, auth.userId]);
    await conn.query('INSERT INTO subscription_events (company_id, event, detail, created_by) VALUES (?,?,?,?)', [auth.companyId, 'payment_declared', JSON.stringify({ period, amount, reference }), auth.userId]);
    await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'subscription.payment_declared', entityType: 'subscription_payments', entityId: pid, ip, meta: { period, amount, reference } });
    return paymentDto(await loadPayment(conn, pid));
  });
  await notifyPlatformOwner(`MHFac : virement déclaré par ${dto.company?.name ?? 'un client'}`,
    `Un client a déclaré un virement à vérifier.\n\nEntreprise : ${dto.company?.name ?? '—'}\nOffre : ${dto.plan?.name ?? '—'} (${period === 'yearly' ? 'annuel' : 'mensuel'})\nMontant attendu : ${dto.amount} ${dto.currency}\nRéférence du virement : ${reference}\nDate indiquée : ${paidOn}\n\nVérifiez votre relevé bancaire puis validez ou rejetez : ${clientUrl('/platform/payments')}\n\nMHFac`);
  return dto;
}

export async function confirmPayment(platformUserId, ip, publicId, { receivedAmount, note }) {
  const out = await withTransaction(async (conn) => {
    const p = await loadPayment(conn, publicId, true);
    if (p.status !== 'pending') throw new HttpError(409, 'ALREADY_PROCESSED', 'Ce paiement a déjà été traité.');
    if (cmpMoney(String(receivedAmount), String(p.amount)) !== 0) {
      throw new HttpError(422, 'AMOUNT_MISMATCH', `Le montant constaté (${receivedAmount}) ne correspond pas au montant attendu (${p.amount} ${p.currency}). Rejetez la déclaration avec un motif : le client pourra la refaire.`, { expected: p.amount, received: String(receivedAmount) });
    }
    const s = await getSubscription(conn, p.company_id, { forUpdate: true });
    if (s.plan_id !== p.plan_id) throw new HttpError(409, 'PLAN_CHANGED', 'L\'offre de l\'entreprise a changé depuis la déclaration : rejetez-la avec un motif.');
    // Échéance : à partir d'aujourd'hui, ou de l'échéance en cours si l'abonnement est actif et non échu (aucun jour payé n'est perdu).
    const today = tunisToday(); const cur = s.current_period_end ? dateOf(s.current_period_end) : null;
    const running = (s.status === 'active' || s.status === 'past_due') && cur && cur > today;
    const periodEnd = addPeriod(running ? cur : today, p.period);
    await conn.query("UPDATE company_subscriptions SET status = 'active', trial_ends_at = NULL, trial_reminder_sent_at = NULL, current_period_end = ?, billing_period = ?, updated_by = ? WHERE company_id = ?",
      [`${periodEnd} 23:59:59`, p.period, platformUserId, p.company_id]);
    await conn.query("UPDATE subscription_payments SET status = 'confirmed', received_amount = ?, review_note = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(), period_end = ? WHERE id = ?", [String(receivedAmount), note ?? null, platformUserId, periodEnd, p.id]);
    const detail = { payment: p.public_id, period: p.period, amount: p.amount, periodEnd };
    await conn.query('INSERT INTO subscription_events (company_id, event, detail, created_by) VALUES (?,?,?,?)', [p.company_id, 'payment_confirmed', JSON.stringify(detail), platformUserId]);
    await audit(conn, { companyId: p.company_id, userId: platformUserId, action: 'platform.payment_confirm', entityType: 'subscription_payments', entityId: p.public_id, ip, meta: detail });
    return { dto: paymentDto(await loadPayment(conn, publicId)), companyId: p.company_id, periodEnd, name: s.plan_name };
  });
  await notifyOwners(out.companyId, 'MHFac : votre paiement est confirmé', `Bonjour,\n\nNous avons bien reçu votre virement. Votre abonnement MHFac (offre ${out.name}) est actif jusqu'au ${out.periodEnd}.\n\nMerci de votre confiance.\nMH Digital Solution`);
  return out.dto;
}

export async function rejectPayment(platformUserId, ip, publicId, { reason }) {
  const out = await withTransaction(async (conn) => {
    const p = await loadPayment(conn, publicId, true);
    if (p.status !== 'pending') throw new HttpError(409, 'ALREADY_PROCESSED', 'Ce paiement a déjà été traité.');
    await conn.query("UPDATE subscription_payments SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE id = ?", [reason, platformUserId, p.id]);
    await conn.query('INSERT INTO subscription_events (company_id, event, detail, created_by) VALUES (?,?,?,?)', [p.company_id, 'payment_rejected', JSON.stringify({ payment: p.public_id, reason }), platformUserId]);
    await audit(conn, { companyId: p.company_id, userId: platformUserId, action: 'platform.payment_reject', entityType: 'subscription_payments', entityId: p.public_id, ip, meta: { reason } });
    return { dto: paymentDto(await loadPayment(conn, publicId)), companyId: p.company_id };
  });
  await notifyOwners(out.companyId, 'MHFac : votre déclaration de paiement n\'a pas pu être validée', `Bonjour,\n\nVotre déclaration de virement n'a pas pu être validée.\nMotif : ${reason}\n\nVous pouvez effectuer une nouvelle déclaration depuis ${clientUrl('/subscription/pay')} ou nous contacter.\n\nMH Digital Solution`);
  return out.dto;
}
export { effectiveStatus };
