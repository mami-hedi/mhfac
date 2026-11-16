import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany } from './helpers.js';
import { pool } from '../src/config/db.js';

let app, admin, A;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };

before(async () => {
  app = await startApp();
  admin = await registerCompany(app.call, 'Plateforme prix'); await pool.query('UPDATE users SET is_platform_admin = 1 WHERE public_id = ?', [admin.userId]);
  A = await registerCompany(app.call, 'Essai A');
});
after(() => app.close());

test('tarifs : offre Pro = 56 TND/mois ou 560 TND/an (2 mois offerts), lus en base et exposés par le serveur', async () => {
  const plans = ok(await c('GET', '/subscription/plans', { token: A.token }));
  const pro = plans.find((p) => p.code === 'pro');
  assert.equal(pro.priceMonthly, '56.000'); assert.equal(pro.priceYearly, '560.000'); assert.equal(pro.yearlyMonthsFree, 2); assert.equal(pro.currency, 'TND');
  const ae = plans.find((p) => p.code === 'auto_entrepreneur'); const biz = plans.find((p) => p.code === 'business');
  assert.equal(ae.priceMonthly, '31.000'); assert.equal(ae.priceYearly, '310.000'); assert.equal(ae.yearlyMonthsFree, 2);
  assert.equal(biz.priceMonthly, '129.000'); assert.equal(biz.priceYearly, '1290.000'); assert.equal(biz.yearlyMonthsFree, 2);
  assert.equal(plans.find((p) => p.code === 'decouverte').priceMonthly, null, 'Découverte reste « sur demande »');
});

test('essai gratuit : chaque nouvelle entreprise démarre en essai de 14 jours, sans restriction', async () => {
  const s = ok(await c('GET', '/subscription', { token: A.token }));
  assert.equal(s.status, 'trial'); assert.equal(s.effectiveStatus, 'trial'); assert.equal(s.readOnly, false); assert.equal(s.trialDaysLeft, 14);
  assert.equal(ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client essai' } }), 201).name, 'Client essai');
});

test('fin d\'essai : lecture seule (écriture 403, lecture et exports possibles) ; activation par l\'administrateur avec périodicité annuelle', async () => {
  await pool.query('UPDATE company_subscriptions SET trial_ends_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE company_id = (SELECT id FROM companies WHERE public_id = ?)', [A.companyId]);
  const s = ok(await c('GET', '/subscription', { token: A.token }));
  assert.equal(s.effectiveStatus, 'expired'); assert.equal(s.readOnly, true); assert.equal(s.trialDaysLeft, null);
  const w = await c('POST', '/clients', { token: A.token, body: { name: 'Après essai' } });
  assert.equal(w.status, 403); assert.equal(w.body.error.code, 'SUBSCRIPTION_INACTIVE');
  assert.equal((await c('GET', '/clients', { token: A.token })).status, 200);
  const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const act = ok(await c('PUT', `/platform/companies/${A.companyId}/subscription`, { token: admin.token, body: { planCode: 'pro', status: 'active', billingPeriod: 'yearly', currentPeriodEnd: future } }));
  assert.equal(act.effectiveStatus, 'active'); assert.equal(act.billingPeriod, 'yearly'); assert.equal(act.readOnly, false);
  assert.equal((await c('POST', '/clients', { token: A.token, body: { name: 'Après activation' } })).status, 201);
  assert.equal((await c('PUT', `/platform/companies/${A.companyId}/subscription`, { token: admin.token, body: { planCode: 'pro', status: 'active', billingPeriod: 'weekly' } })).status, 400);
});

test('espace plateforme : prix annuel validé, modifiable et journalisé ; un propriétaire ne peut pas modifier un prix', async () => {
  const code = `prix_${Date.now().toString(36)}`;
  const body = { name: 'Offre prix', priceMonthly: '10', priceYearly: '100', currency: 'TND', limits: { users: 1, invoicesPerMonth: 5, warehouses: 1, scansPerMonth: 1, exportsPerMonth: 1 }, features: { einvoice: false, purchaseScan: false, reportsExport: false }, isPublic: false, isActive: false };
  assert.equal((await c('POST', '/platform/plans', { token: A.token, body: { ...body, code } })).status, 403);
  assert.equal((await c('POST', '/platform/plans', { token: admin.token, body: { ...body, code, priceYearly: '12,5abc' } })).status, 400);
  const p = ok(await c('POST', '/platform/plans', { token: admin.token, body: { ...body, code } }), 201);
  assert.equal(p.priceYearly, '100.000'); assert.equal(p.yearlyMonthsFree, 2);
  const u = ok(await c('PUT', `/platform/plans/${p.id}`, { token: admin.token, body: { ...body, priceYearly: null } }));
  assert.equal(u.priceYearly, null); assert.equal(u.yearlyMonthsFree, null);
});
