import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, sentMails } from './helpers.js';
import { pool } from '../src/config/db.js';
import { tunisToday } from '../src/modules/subscription/payments.service.js';

let app, admin, A, B, C, savedInfo;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = tunisToday();
const plusDays = (d) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const bank = { beneficiary: 'SARL Exemple Test', bankName: 'Banque Exemple', rib: '08 006 0110123456789 74', iban: 'TN98 0800 6011 0123 4567 8974', bic: 'BXMPTNTT', contactEmail: 'proprio@exemple.test', contactPhone: '71 000 000', instructions: null };
const setSub = (co, body) => c('PUT', `/platform/companies/${co.companyId}/subscription`, { token: admin.token, body });

before(async () => {
  app = await startApp();
  [[savedInfo]] = await pool.query('SELECT * FROM platform_payment_info WHERE id = 1');
  await pool.query("UPDATE company_subscriptions SET status = 'cancelled' WHERE status IN ('trial','active','past_due')"); // base de test partagée : on neutralise les entreprises des autres fichiers pour tester les listes « à traiter »
  admin = await registerCompany(app.call, 'Admin plateforme'); await pool.query('UPDATE users SET is_platform_admin = 1 WHERE public_id = ?', [admin.userId]);
  A = await registerCompany(app.call, 'Adm A'); B = await registerCompany(app.call, 'Adm B'); C = await registerCompany(app.call, 'Adm C');
  await pool.query("UPDATE subscription_payments SET status = 'rejected', review_note = 'nettoyage test' WHERE status = 'pending'"); // la base de test est partagée avec d'autres fichiers
  ok(await c('PUT', '/platform/payment-info', { token: admin.token, body: bank }));
  ok(await setSub(A, { planCode: 'pro', status: 'trial', trialEndsAt: plusDays(3) }));
  ok(await setSub(B, { planCode: 'pro', status: 'active', billingPeriod: 'monthly', currentPeriodEnd: plusDays(-5) })); // échue
  ok(await setSub(C, { planCode: 'pro', status: 'active', billingPeriod: 'yearly', currentPeriodEnd: plusDays(200) }));
});
after(async () => {
  const s = savedInfo;
  await pool.query('UPDATE platform_payment_info SET beneficiary=?, bank_name=?, rib=?, iban=?, bic=?, contact_email=?, contact_phone=?, instructions=?, is_configured=? WHERE id=1', [s.beneficiary, s.bank_name, s.rib, s.iban, s.bic, s.contact_email, s.contact_phone, s.instructions, s.is_configured]);
  await app.close();
});

test('liste des entreprises : offre, statut réel, échéance utile (essai ou période) et filtre par abonnement', async () => {
  const get = async (q) => (await c('GET', `/platform/companies?limit=100&${q}`, { token: admin.token })).body.data;
  const all = await get('');
  const a = all.find((x) => x.id === A.companyId); const b = all.find((x) => x.id === B.companyId); const cc = all.find((x) => x.id === C.companyId);
  assert.equal(a.effectiveStatus, 'trial'); assert.ok(String(a.dueDate).startsWith(plusDays(3)), 'échéance d\'un essai = fin d\'essai');
  assert.equal(b.effectiveStatus, 'expired'); assert.ok(String(b.dueDate).startsWith(plusDays(-5)));
  assert.equal(cc.effectiveStatus, 'active'); assert.ok(String(cc.dueDate).startsWith(plusDays(200)));
  const ids = (l) => l.map((x) => x.id);
  assert.ok(ids(await get('subscription=expired')).includes(B.companyId)); assert.ok(!ids(await get('subscription=expired')).includes(A.companyId));
  assert.ok(ids(await get('subscription=trial')).includes(A.companyId)); assert.ok(!ids(await get('subscription=trial')).includes(B.companyId));
  assert.ok(ids(await get('subscription=expiring')).includes(A.companyId), 'essai finissant dans 3 jours = échéance proche');
  assert.ok(!ids(await get('subscription=expiring')).includes(C.companyId));
  assert.ok(ids(await get('subscription=active')).includes(C.companyId)); assert.ok(!ids(await get('subscription=active')).includes(B.companyId), 'une période échue n\'est plus « actif »');
  assert.equal((await c('GET', '/platform/companies?subscription=bidon', { token: admin.token })).status, 400);
  assert.equal((await c('GET', '/platform/companies?subscription=expired', { token: A.token })).status, 403);
});

test('virement déclaré : le propriétaire de la plateforme est prévenu, la déclaration apparaît dans « à traiter », la validation active et fixe l\'échéance', async () => {
  const before = sentMails.length;
  const d = ok(await c('POST', '/subscription/payments', { token: A.token, body: { period: 'yearly', reference: 'VIR-ADM-1', paidOn: today } }), 201);
  const mails = sentMails.slice(before).filter((m) => m.to === 'proprio@exemple.test');
  assert.equal(mails.length, 1, 'une alerte au propriétaire de la plateforme');
  assert.match(mails[0].subject, /Adm A/); assert.match(mails[0].text, /VIR-ADM-1/); assert.match(mails[0].text, /\/platform\/payments/);
  const ov = ok(await c('GET', '/platform/overview', { token: admin.token }));
  const row = ov.toProcess.payments.find((p) => p.id === d.id); assert.ok(row, 'visible dans « à traiter »'); assert.match(row.company.name, /^Adm A/); assert.equal(row.reference, 'VIR-ADM-1');
  assert.ok(ov.toProcess.dueSoon.some((x) => x.company.id === A.companyId && !x.expired), 'essai proche listé');
  assert.ok(ov.toProcess.dueSoon.some((x) => x.company.id === B.companyId && x.expired), 'échéance dépassée récemment listée');
  assert.ok(!ov.toProcess.dueSoon.some((x) => x.company.id === C.companyId));
  assert.ok(ov.expiredSubscriptions >= 1);
  const conf = ok(await c('POST', `/platform/payments/${d.id}/confirm`, { token: admin.token, body: { receivedAmount: d.amount } }));
  assert.equal(conf.status, 'confirmed');
  const after = (await c('GET', `/platform/companies?limit=100`, { token: admin.token })).body.data.find((x) => x.id === A.companyId);
  assert.equal(after.effectiveStatus, 'active'); assert.ok(String(after.dueDate).startsWith(`${Number(today.slice(0, 4)) + 1}`) || String(after.dueDate) > plusDays(300));
  const ov2 = ok(await c('GET', '/platform/overview', { token: admin.token })); assert.ok(!ov2.toProcess.payments.some((p) => p.id === d.id), 'traité : sorti de « à traiter »');
});

test('alerte : PLATFORM_ALERT_EMAIL est prioritaire ; un échec d\'envoi ne bloque pas le client', async () => {
  const { env } = await import('../src/config/env.js');
  const prev = env.PLATFORM_ALERT_EMAIL; env.PLATFORM_ALERT_EMAIL = 'alerte@exemple.test';
  try {
    const before = sentMails.length;
    ok(await c('POST', '/subscription/payments', { token: B.token, body: { period: 'monthly', reference: 'VIR-ADM-2', paidOn: today } }), 201);
    assert.ok(sentMails.slice(before).some((m) => m.to === 'alerte@exemple.test'));
    assert.ok(!sentMails.slice(before).some((m) => m.to === 'proprio@exemple.test'), 'un seul destinataire d\'alerte');
  } finally { env.PLATFORM_ALERT_EMAIL = prev; }
  await pool.query("UPDATE platform_payment_info SET contact_email = NULL WHERE id = 1");
  const before = sentMails.length;
  ok(await c('POST', '/subscription/payments', { token: C.token, body: { period: 'monthly', reference: 'VIR-ADM-3', paidOn: today } }), 201); // aucune adresse : déclaration acceptée, aucune alerte
  assert.equal(sentMails.slice(before).filter((m) => /virement déclaré/.test(m.subject)).length, 0);
});

test('offres publiques (page d\'accueil) : sans connexion, uniquement les offres actives et publiques, aucune donnée d\'entreprise', async () => {
  const r = await c('GET', '/public/plans'); assert.equal(r.status, 200);
  const plans = r.body.data; assert.ok(plans.some((p) => p.code === 'pro'));
  assert.ok(plans.every((p) => p.code && p.name && p.limits && p.features), 'forme attendue');
  const [inactive] = await pool.query('SELECT code FROM subscription_plans WHERE is_active = 0 OR is_public = 0');
  for (const x of inactive) assert.ok(!plans.some((p) => p.code === x.code), `offre masquée : ${x.code}`);
  assert.equal(JSON.stringify(plans).includes('company'), false);
});
