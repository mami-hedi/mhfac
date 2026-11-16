import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember, uniqueEmail, PASSWORD } from './helpers.js';
import { pool } from '../src/config/db.js';

const PLAN = `mini_${Date.now().toString(36)}`;
let app, admin, A, B, tax19, client;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const assign = (company, body) => c('PUT', `/platform/companies/${company.companyId}/subscription`, { token: admin.token, body: { status: 'active', ...body } });
const mkInvoice = async (token) => { const d = ok(await c('POST', '/invoices', { token, body: { clientId: client.id, issueDate: today, lines: [{ description: 'X', quantity: 1, unitPrice: '10', taxRateId: tax19.id }] } }), 201); return c('POST', `/invoices/${d.id}/issue`, { token }); };

before(async () => {
  app = await startApp();
  admin = await registerCompany(app.call, 'Plateforme'); await pool.query('UPDATE users SET is_platform_admin = 1 WHERE public_id = ?', [admin.userId]);
  A = await registerCompany(app.call, 'Abo A'); B = await registerCompany(app.call, 'Abo B');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client' } }), 201); tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
});
after(() => app.close());

test('espace plateforme : accès réservé, entreprises, offres, journal', async () => {
  assert.equal((await c('GET', '/platform/overview', { token: A.token })).status, 403, 'un propriétaire d\'entreprise n\'est pas super admin');
  assert.equal((await c('GET', '/platform/overview')).status, 401);
  const ov = ok(await c('GET', '/platform/overview', { token: admin.token })); assert.ok(ov.companies >= 3); assert.ok(ov.byPlan.length >= 4);
  const list = await c('GET', `/platform/companies?q=${encodeURIComponent('Abo A')}`, { token: admin.token }); assert.ok(list.body.data.some((x) => x.id === A.companyId));
  const det = ok(await c('GET', `/platform/companies/${A.companyId}`, { token: admin.token })); assert.equal(det.plan.code, 'business'); assert.ok(det.members.length >= 1);
  assert.equal(det.invoices, undefined, 'aucune donnée métier exposée'); assert.equal(det.clients, undefined);
  // création / modification d'une offre (aucun prix codé en dur)
  const limits = { users: 1, invoicesPerMonth: 2, warehouses: 1, scansPerMonth: 1, exportsPerMonth: 1 }; const features = { einvoice: false, purchaseScan: false, reportsExport: false, support: 'Test' };
  const p = ok(await c('POST', '/platform/plans', { token: admin.token, body: { code: PLAN, name: 'Mini test', limits, features, priceMonthly: '19.900' } }), 201); assert.equal(p.priceMonthly, '19.900');
  assert.equal((await c('POST', '/platform/plans', { token: admin.token, body: { code: PLAN, name: 'Doublon', limits, features } })).status, 409);
  assert.equal((await c('POST', '/platform/plans', { token: admin.token, body: { code: 'bad', name: 'X', limits: { ...limits, users: -1 }, features } })).status, 400);
  assert.equal((await c('POST', '/platform/plans', { token: A.token, body: { code: 'hack', name: 'X', limits, features } })).status, 403);
  ok(await c('PUT', `/platform/plans/${p.id}`, { token: admin.token, body: { name: 'Mini test 2', limits, features, priceMonthly: null } }));
  const hist = ok(await c('GET', `/platform/companies/${B.companyId}`, { token: admin.token })).history; assert.ok(Array.isArray(hist));
});

test('limites serveur : factures, utilisateurs, entrepôts, fonctionnalités, exports', async () => {
  ok(await assign(A, { planCode: PLAN }));
  const sub = ok(await c('GET', '/subscription', { token: A.token })); assert.equal(sub.plan.code, PLAN); assert.equal(sub.usage.invoicesPerMonth, 0); assert.equal(sub.readOnly, false);
  assert.equal((await mkInvoice(A.token)).status, 200); assert.equal((await mkInvoice(A.token)).status, 200);
  const third = await mkInvoice(A.token); assert.equal(third.status, 403); assert.equal(third.body.error.code, 'PLAN_LIMIT_REACHED'); assert.equal(third.body.error.details.max, 2);
  assert.equal(ok(await c('GET', '/subscription', { token: A.token })).usage.invoicesPerMonth, 2);
  // l'autre entreprise (plan business) n'est pas limitée
  assert.equal((await mkInvoiceFor(B)).status, 200);
  // utilisateurs : 1 inclus (le propriétaire) -> invitation refusée
  const inv = await c('POST', '/users/invitations', { token: A.token, body: { email: uniqueEmail('x'), roleCode: 'sales' } }); assert.equal(inv.body.error.code, 'PLAN_LIMIT_REACHED');
  // entrepôts : 1 inclus (défaut) -> création refusée
  const wh = await c('POST', '/stock/warehouses', { token: A.token, body: { code: 'DEP2', name: 'Dépôt 2' } }); assert.equal(wh.body.error.code, 'PLAN_LIMIT_REACHED');
  // fonctionnalités absentes du plan
  const ei = await c('GET', '/e-invoicing/config', { token: A.token }); assert.equal(ei.body.error.code, 'FEATURE_NOT_IN_PLAN');
  const ex = await c('GET', '/reports/by_client?format=csv', { token: A.token }); assert.equal(ex.body.error.code, 'FEATURE_NOT_IN_PLAN');
  assert.equal((await c('GET', '/reports/by_client?format=json', { token: A.token })).status, 200, 'la consultation à l\'écran reste possible');
  // plan supérieur : les limites sautent aussitôt
  ok(await assign(A, { planCode: 'pro' })); assert.equal((await mkInvoice(A.token)).status, 200);
  assert.equal((await c('GET', '/e-invoicing/config', { token: A.token })).status, 200);
  assert.equal((await c('GET', '/subscription', { token: B.token })).body.data.plan.code, 'business');
  assert.equal((await c('GET', '/subscription', { token: (await addMember(app.call, A, 'sales')).token })).status, 403, 'réservé propriétaire/admin');
});
const mkInvoiceFor = async (co) => { const cl = ok(await c('POST', '/clients', { token: co.token, body: { name: 'Client B' } }), 201); const t = ok(await c('GET', '/tax-rates', { token: co.token })).find((x) => x.rate === '19.00');
  const d = ok(await c('POST', '/invoices', { token: co.token, body: { clientId: cl.id, issueDate: today, lines: [{ description: 'X', quantity: 1, unitPrice: '10', taxRateId: t.id }] } }), 201); return c('POST', `/invoices/${d.id}/issue`, { token: co.token }); };

test('abonnement expiré/annulé : lecture seule ; suspension d\'entreprise ; plan inapplicable', async () => {
  const C = await registerCompany(app.call, 'Abo C');
  ok(await assign(C, { planCode: 'business', status: 'trial', trialEndsAt: '2099-01-01' }));
  assert.equal(ok(await c('GET', '/subscription', { token: C.token })).effectiveStatus, 'trial');
  assert.equal((await c('POST', '/clients', { token: C.token, body: { name: 'OK pendant l\'essai' } })).status, 201);
  assert.equal((await assign(C, { planCode: 'business', status: 'trial' })).body.error.code, 'TRIAL_END_REQUIRED');
  ok(await assign(C, { planCode: 'business', status: 'active', currentPeriodEnd: '2020-01-01' })); // période échue
  const w = await c('POST', '/clients', { token: C.token, body: { name: 'Bloqué' } }); assert.equal(w.status, 403); assert.equal(w.body.error.code, 'SUBSCRIPTION_INACTIVE');
  assert.equal((await c('GET', '/clients', { token: C.token })).status, 200, 'lecture toujours possible');
  assert.equal((await c('GET', '/reports/by_client?format=csv', { token: C.token })).status, 200, 'export de ses données toujours possible');
  assert.equal((await c('GET', '/subscription', { token: C.token })).body.data.readOnly, true);
  ok(await assign(C, { planCode: 'business', status: 'cancelled' })); assert.equal((await c('POST', '/clients', { token: C.token, body: { name: 'Bloqué 2' } })).status, 403);
  ok(await assign(C, { planCode: 'business', status: 'active' })); assert.equal((await c('POST', '/clients', { token: C.token, body: { name: 'Rétabli' } })).status, 201);
  // consommation > limites du plan cible : refus explicite
  const sm = await c('PUT', `/platform/companies/${C.companyId}/subscription`, { token: admin.token, body: { planCode: 'decouverte', status: 'active' } }); assert.equal(sm.status, 200);
  await addMember(app.call, C, 'sales').catch(() => {}); // refusé par le plan (1 utilisateur) : ne doit pas planter
  // suspension de l'entreprise : plus aucun accès
  assert.equal((await c('POST', `/platform/companies/${C.companyId}/suspend`, { token: admin.token, body: { reason: 'Impa' } })).status, 400);
  assert.equal((await c('POST', `/platform/companies/${C.companyId}/suspend`, { token: admin.token, body: { reason: 'Facture impayée' } })).status, 204);
  assert.equal((await c('GET', '/clients', { token: C.token })).status, 403);
  assert.equal((await c('POST', `/platform/companies/${C.companyId}/suspend`, { token: admin.token, body: { reason: 'Facture impayée' } })).status, 409);
  assert.equal((await c('POST', `/platform/companies/${C.companyId}/reactivate`, { token: admin.token, body: { reason: 'Réglé par virement' } })).status, 204);
  assert.equal((await c('GET', '/clients', { token: C.token })).status, 200);
  // plan inactif non attribuable
  const pl = ok(await c('GET', '/platform/plans', { token: admin.token })).find((p) => p.code === PLAN);
  ok(await c('PUT', `/platform/plans/${pl.id}`, { token: admin.token, body: { name: pl.name, limits: pl.limits, features: pl.features, isActive: false } }));
  assert.equal((await assign(C, { planCode: PLAN })).body.error.code, 'PLAN_INACTIVE');
  assert.equal((await assign(C, { planCode: 'inconnu' })).status, 422);
});
