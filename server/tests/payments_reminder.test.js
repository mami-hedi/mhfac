import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember, sentMails } from './helpers.js';
import { pool } from '../src/config/db.js';
import { addPeriod, tunisToday } from '../src/modules/subscription/payments.service.js';
import { runTrialReminders } from '../src/modules/subscription/trial-reminders.js';

let app, admin, A, B, readOnly;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = tunisToday();
const plusDays = (d) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const bank = { beneficiary: 'SARL Exemple Test', bankName: 'Banque Exemple', rib: '08 006 0110123456789 74', iban: 'TN98 0800 6011 0123 4567 8974', bic: 'BXMPTNTT', contactEmail: 'paiement@exemple.test', contactPhone: '71 000 000', instructions: 'Libellé : votre référence.' };
const decl = (token, body = {}) => c('POST', '/subscription/payments', { token, body: { period: 'yearly', reference: 'VIR-2026-001', paidOn: today, ...body } });
const sub = async (t) => ok(await c('GET', '/subscription', { token: t.token }));
const setTrialEnd = (co, iso) => pool.query("UPDATE company_subscriptions SET status='trial', trial_reminder_sent_at=NULL, trial_ends_at=? WHERE company_id=(SELECT id FROM companies WHERE public_id=?)", [`${iso} 23:59:59`, co.companyId]);
let savedInfo;

before(async () => {
  app = await startApp();
  [[savedInfo]] = await pool.query('SELECT * FROM platform_payment_info WHERE id = 1');
  admin = await registerCompany(app.call, 'Plateforme paiements'); await pool.query('UPDATE users SET is_platform_admin = 1 WHERE public_id = ?', [admin.userId]);
  A = await registerCompany(app.call, 'Paiement A'); B = await registerCompany(app.call, 'Paiement B'); readOnly = await addMember(app.call, A, 'read_only');
  ok(await c('PUT', `/platform/companies/${A.companyId}/subscription`, { token: admin.token, body: { planCode: 'pro', status: 'trial', trialEndsAt: plusDays(10) } }));
});
after(async () => {
  const s = savedInfo; // remet la ligne d'origine : les autres tests et la base de développement ne gardent pas les coordonnées de test
  await pool.query('UPDATE platform_payment_info SET beneficiary=?, bank_name=?, rib=?, iban=?, bic=?, contact_email=?, contact_phone=?, instructions=?, is_configured=? WHERE id=1', [s.beneficiary, s.bank_name, s.rib, s.iban, s.bic, s.contact_email, s.contact_phone, s.instructions, s.is_configured]);
  await app.close();
});

test('coordonnées bancaires : valeurs de remplacement jamais montrées aux entreprises ; paiement impossible tant qu\'elles ne sont pas enregistrées', async () => {
  const p = ok(await c('GET', '/subscription/payment-info', { token: A.token }));
  assert.equal(p.configured, false); assert.equal(p.bank, null); assert.ok(!JSON.stringify(p).includes('COMPLÉTER'));
  assert.deepEqual(p.options.map((o) => [o.period, o.amount]), [['monthly', '56.000'], ['yearly', '560.000']]); assert.equal(p.options[1].monthsFree, 2);
  assert.match(p.transferReference, /^MHFAC-[0-9A-F]{8}$/);
  const r = await decl(A.token); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'PAYMENT_NOT_AVAILABLE');
});

test('espace plateforme : saisie validée des coordonnées (RIB, valeurs de remplacement refusées), réservée au super admin', async () => {
  assert.equal((await c('PUT', '/platform/payment-info', { token: A.token, body: bank })).status, 403, 'un propriétaire ne modifie pas les coordonnées');
  assert.equal((await c('PUT', '/platform/payment-info', { token: admin.token, body: { ...bank, rib: '123' } })).status, 400);
  assert.equal((await c('PUT', '/platform/payment-info', { token: admin.token, body: { ...bank, beneficiary: 'MH DIGITAL SOLUTION (À COMPLÉTER)' } })).status, 422);
  assert.equal((await c('PUT', '/platform/payment-info', { token: admin.token, body: { ...bank, rib: '00 000 0000000000000 00' } })).status, 422);
  const put = (extra) => c('PUT', '/platform/payment-info', { token: admin.token, body: { ...bank, ...extra } });
  for (const extra of [{ iban: 'TN59 0000 0000 0000 0000 0000' }, { iban: 'TN98 0800 6011 0123 4567 8975' }, { iban: 'TN98 0800 6011 0123 4567 8974', rib: '08 006 0110123456789 75' }, { bic: 'XXXXTNTT' }, { bic: 'abc' }]) {
    const r = await put(extra); assert.ok([400, 422].includes(r.status), `${JSON.stringify(extra)} -> ${r.status}`);
  }
  assert.equal((await c('GET', '/subscription/payment-info', { token: B.token })).body.data.configured, false, 'rien n\'est publié après des refus');
  const g = ok(await put({})); assert.equal(g.configured, true);
  const p = ok(await c('GET', '/subscription/payment-info', { token: B.token })); assert.equal(p.configured, true); assert.equal(p.bank.rib, bank.rib); assert.equal(p.contactEmail, bank.contactEmail);
  const [[log]] = await pool.query("SELECT meta FROM audit_logs WHERE action = 'platform.payment_info_update' ORDER BY id DESC LIMIT 1"); assert.ok(!JSON.stringify(log.meta).includes('0123456789'), 'le RIB n\'est pas copié dans le journal');
});

test('déclaration : montant et offre calculés par le serveur, une seule en attente, droits et validations', async () => {
  assert.equal((await decl(A.token, { amount: '1.000' })).status, 400, 'aucun montant accepté du client');
  assert.equal((await decl(A.token, { period: 'weekly' })).status, 400);
  assert.equal((await decl(A.token, { reference: 'x' })).status, 400);
  assert.equal((await decl(A.token, { paidOn: plusDays(3) })).status, 422);
  assert.equal((await decl(readOnly.token)).status, 403, 'lecture seule : pas de déclaration');
  const d = ok(await decl(A.token, { note: 'Virement BIAT' }), 201);
  assert.equal(d.status, 'pending'); assert.equal(d.amount, '560.000'); assert.equal(d.currency, 'TND'); assert.equal(d.plan.code, 'pro'); assert.equal(d.period, 'yearly');
  const again = await decl(A.token, { period: 'monthly', reference: 'VIR-2' }); assert.equal(again.status, 409); assert.equal(again.body.error.code, 'PAYMENT_PENDING');
  assert.equal((await sub(A)).effectiveStatus, 'trial', 'rien n\'est activé sur la seule déclaration');
  assert.equal(ok(await c('GET', '/subscription/payments', { token: A.token })).length, 1);
  assert.equal(ok(await c('GET', '/subscription/payments', { token: B.token })).length, 0, 'isolation entre entreprises');
});

test('confirmation par l\'administrateur : montant constaté contrôlé, abonnement activé, échéance calculée, e-mail, pas de double traitement', async () => {
  const pending = ok(await c('GET', '/platform/payments?status=pending', { token: admin.token })).find((p) => p.company.id === A.companyId);
  assert.ok(pending);
  assert.equal((await c('POST', `/platform/payments/${pending.id}/confirm`, { token: A.token, body: { receivedAmount: '560' } })).status, 403);
  const bad = await c('POST', `/platform/payments/${pending.id}/confirm`, { token: admin.token, body: { receivedAmount: '500' } }); assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'AMOUNT_MISMATCH');
  assert.equal((await sub(A)).effectiveStatus, 'trial');
  const before = sentMails.length;
  const done = ok(await c('POST', `/platform/payments/${pending.id}/confirm`, { token: admin.token, body: { receivedAmount: '560.000', note: 'Relevé du jour' } }));
  assert.equal(done.status, 'confirmed'); assert.equal(done.periodEnd, addPeriod(today, 'yearly'));
  const s = await sub(A); assert.equal(s.effectiveStatus, 'active'); assert.equal(s.billingPeriod, 'yearly'); assert.equal(s.trialEndsAt, null); assert.equal(String(s.currentPeriodEnd).slice(0, 10), done.periodEnd); assert.equal(s.readOnly, false);
  assert.ok(sentMails.slice(before).some((m) => m.to === A.email && /paiement est confirmé/.test(m.subject)));
  const twice = await c('POST', `/platform/payments/${pending.id}/confirm`, { token: admin.token, body: { receivedAmount: '560.000' } }); assert.equal(twice.status, 409);
  // Renouvellement mensuel pendant que l'abonnement court : l'échéance s'ajoute à l'échéance en cours (aucun jour payé n'est perdu).
  const d2 = ok(await decl(A.token, { period: 'monthly', reference: 'VIR-2026-002' }), 201); assert.equal(d2.amount, '56.000');
  const c2 = ok(await c('POST', `/platform/payments/${d2.id}/confirm`, { token: admin.token, body: { receivedAmount: 56 } }));
  assert.equal(c2.periodEnd, addPeriod(done.periodEnd, 'monthly'));
});

test('rejet : motif obligatoire, e-mail au client, nouvelle déclaration possible ; abonnement expiré peut quand même déclarer', async () => {
  await setTrialEnd(A, plusDays(-2)); // essai échu -> lecture seule
  await pool.query("UPDATE company_subscriptions SET status='trial', current_period_end=NULL WHERE company_id=(SELECT id FROM companies WHERE public_id=?)", [A.companyId]);
  assert.equal((await sub(A)).effectiveStatus, 'expired');
  assert.equal((await c('POST', '/clients', { token: A.token, body: { name: 'Bloqué' } })).status, 403);
  const d = ok(await decl(A.token, { reference: 'VIR-3', period: 'monthly' }), 201);
  assert.equal((await c('POST', `/platform/payments/${d.id}/reject`, { token: admin.token, body: { reason: 'ab' } })).status, 400);
  const before = sentMails.length;
  const r = ok(await c('POST', `/platform/payments/${d.id}/reject`, { token: admin.token, body: { reason: 'Virement introuvable sur le relevé' } }));
  assert.equal(r.status, 'rejected'); assert.equal((await sub(A)).effectiveStatus, 'expired', 'un rejet n\'active rien');
  assert.ok(sentMails.slice(before).some((m) => m.to === A.email && /Virement introuvable/.test(m.text)));
  assert.equal((await c('POST', `/platform/payments/${d.id}/reject`, { token: admin.token, body: { reason: 'Encore une fois' } })).status, 409);
  ok(await decl(A.token, { reference: 'VIR-4', period: 'monthly' }), 201);
  const ov = ok(await c('GET', '/platform/overview', { token: admin.token })); assert.ok(ov.pendingPayments >= 1);
});

test('rappel de fin d\'essai : envoyé une seule fois au seuil (jour 12 sur 14), jamais avant, jamais après expiration', async () => {
  const R = await registerCompany(app.call, 'Rappel R'); const E = await registerCompany(app.call, 'Rappel Expire'); const F = await registerCompany(app.call, 'Rappel Futur');
  ok(await c('PUT', `/platform/companies/${R.companyId}/subscription`, { token: admin.token, body: { planCode: 'pro', status: 'trial', trialEndsAt: plusDays(2) } }));
  await setTrialEnd(E, plusDays(-2)); await setTrialEnd(F, plusDays(3));
  const mine = (e) => sentMails.filter((m) => m.to === e.email && /essai gratuit se termine/.test(m.subject));
  const r1 = await runTrialReminders(); assert.ok(r1.sent >= 1);
  assert.equal(mine(R).length, 1); assert.equal(mine(E).length, 0, 'essai échu : pas de rappel'); assert.equal(mine(F).length, 0, 'trop tôt (3 jours restants)');
  const t = mine(R)[0].text; assert.ok(t.includes('dans 2 jours')); assert.ok(t.includes('/subscription/pay')); assert.ok(t.includes('56 TND par mois') && t.includes('560 TND par an')); assert.ok(!t.includes(bank.rib), 'aucune coordonnée bancaire dans l\'e-mail');
  await runTrialReminders(); assert.equal(mine(R).length, 1, 'aucun doublon');
  const [[m]] = await pool.query("SELECT trial_reminder_sent_at FROM company_subscriptions WHERE company_id=(SELECT id FROM companies WHERE public_id=?)", [R.companyId]); assert.ok(m.trial_reminder_sent_at);
  await setTrialEnd(F, plusDays(2)); await runTrialReminders(); assert.equal(mine(F).length, 1, 'le seuil atteint déclenche le rappel');
  // Si l'administrateur prolonge l'essai, un nouveau rappel sera possible.
  ok(await c('PUT', `/platform/companies/${R.companyId}/subscription`, { token: admin.token, body: { planCode: 'pro', status: 'trial', trialEndsAt: plusDays(9) } }));
  const [[m2]] = await pool.query("SELECT trial_reminder_sent_at FROM company_subscriptions WHERE company_id=(SELECT id FROM companies WHERE public_id=?)", [R.companyId]); assert.equal(m2.trial_reminder_sent_at, null);
});
