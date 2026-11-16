// Rappel de fin d'essai : au jour TRIAL_REMINDER_DAY de l'essai (12 par défaut, pour un essai de 14 jours), un e-mail prévient le(s) propriétaire(s)
// que l'essai se termine et les invite à passer au paiement. Une seule fois par essai : le marqueur trial_reminder_sent_at est posé AVANT l'envoi
// (UPDATE conditionnel), donc deux instances ou deux passages ne produisent jamais de doublon ; en cas d'échec d'envoi le marqueur est retiré pour un nouvel essai.
import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { sendMail, clientUrl } from '../../core/mailer.js';
import { audit } from '../../core/audit.js';
import { tunisToday, ownerEmails, loadPaymentInfo } from './payments.service.js';

const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const fmt = (iso) => iso.split('-').reverse().join('/');
const money = (v, cur) => `${Number(v).toLocaleString('fr-FR', { minimumFractionDigits: Number(v) % 1 ? 3 : 0, maximumFractionDigits: 3 })} ${cur}`;

export function reminderText({ companyName, daysLeft, endIso, plan, priceMonthly, priceYearly, currency, payUrl, contact }) {
  const when = daysLeft <= 0 ? 'se termine aujourd\'hui' : `se termine dans ${daysLeft} jour${daysLeft > 1 ? 's' : ''} (le ${fmt(endIso)})`;
  const prices = [priceMonthly != null && `${money(priceMonthly, currency)} par mois`, priceYearly != null && `${money(priceYearly, currency)} par an`].filter(Boolean).join(' ou ');
  return `Bonjour,\n\nVotre période d'essai gratuite de MHFac pour « ${companyName} » ${when}.\n\n`
    + `Pour continuer sans interruption, passez au paiement de l'offre ${plan}${prices ? ` : ${prices}` : ''}.\n`
    + `Le paiement se fait par virement bancaire ; vos coordonnées de virement et le formulaire de déclaration sont ici :\n${payUrl}\n\n`
    + `À la fin de l'essai, l'application passe en lecture seule : vos données restent consultables et exportables, et tout est réactivé dès la confirmation de votre paiement.\n`
    + `${contact ? `\nUne question ? ${contact}\n` : ''}\nMH Digital Solution`;
}

export async function runTrialReminders(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(now);
  const threshold = Math.max(0, env.TRIAL_DAYS - env.TRIAL_REMINDER_DAY); // jours restants à partir desquels on rappelle
  const [rows] = await pool.query(`SELECT s.company_id, s.trial_ends_at, c.name AS company_name, p.name AS plan_name, p.price_monthly, p.price_yearly, p.currency
    FROM company_subscriptions s JOIN companies c ON c.id = s.company_id JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.status = 'trial' AND s.trial_reminder_sent_at IS NULL AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at > ? AND c.status = 'active'`, [now]);
  const info = await loadPaymentInfo(); const contact = info.is_configured ? [info.contact_email, info.contact_phone].filter(Boolean).join(' · ') : '';
  const out = { sent: 0, skipped: 0, failed: [] };
  for (const r of rows) {
    const endIso = r.trial_ends_at.toISOString().slice(0, 10); const daysLeft = dayDiff(endIso, today);
    if (daysLeft > threshold) { out.skipped++; continue; }
    const [claim] = await pool.query('UPDATE company_subscriptions SET trial_reminder_sent_at = UTC_TIMESTAMP() WHERE company_id = ? AND trial_reminder_sent_at IS NULL', [r.company_id]);
    if (!claim.affectedRows) continue;
    try {
      const to = await ownerEmails(pool, r.company_id);
      const text = reminderText({ companyName: r.company_name, daysLeft, endIso, plan: r.plan_name, priceMonthly: r.price_monthly, priceYearly: r.price_yearly, currency: r.currency, payUrl: clientUrl('/subscription/pay'), contact });
      for (const t of to) await sendMail({ to: t, subject: 'MHFac : votre essai gratuit se termine bientôt — passez au paiement', text });
      await pool.query('INSERT INTO subscription_events (company_id, event, detail) VALUES (?,?,?)', [r.company_id, 'trial_reminder_sent', JSON.stringify({ daysLeft, recipients: to.length })]);
      await audit(null, { companyId: r.company_id, action: 'subscription.trial_reminder', entityType: 'company_subscriptions', entityId: String(r.company_id), meta: { daysLeft, recipients: to.length } });
      out.sent++;
    } catch (e) {
      await pool.query('UPDATE company_subscriptions SET trial_reminder_sent_at = NULL WHERE company_id = ?', [r.company_id]); // sera retenté au prochain passage
      out.failed.push({ companyId: r.company_id, error: e.message });
    }
  }
  return out;
}

export function startTrialReminderScheduler(intervalMs = 3_600_000) {
  const tick = () => runTrialReminders().then((r) => { if (r.sent || r.failed.length) console.log(`[trial-reminders] ${r.sent} rappel(s) envoyé(s), ${r.failed.length} échec(s)`); }).catch((e) => console.error('[trial-reminders]', e.message));
  const first = setTimeout(tick, 30_000); const timer = setInterval(tick, intervalMs);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
