import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';
import { pool } from '../src/config/db.js';
import { scanCompany, resetScanThrottle } from '../src/modules/notifications/notifications.service.js';

let app, A, B, accountant, stockMgr, sales, readOnly, admin, client, tax19;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const plusDays = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dbId = async (publicId) => (await pool.query('SELECT id FROM companies WHERE public_id = ?', [publicId]))[0][0].id;
const list = async (who, q = '') => { resetScanThrottle(); return ok(await c('GET', `/notifications${q}`, { token: who.token })); };
const types = async (who) => (await list(who)).map((n) => n.type);

before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Notif A'); B = await registerCompany(app.call, 'Notif B');
  accountant = await addMember(app.call, A, 'accountant'); stockMgr = await addMember(app.call, A, 'stock_manager');
  sales = await addMember(app.call, A, 'sales'); readOnly = await addMember(app.call, A, 'read_only'); admin = await addMember(app.call, A, 'admin');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Notif' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
});
after(() => app.close());

const invoice = async (body = {}) => {
  const d = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: '2026-01-01', dueDate: '2026-01-31', lines: [{ description: 'Prestation', quantity: 1, unitPrice: '100.000', taxRateId: tax19.id }], ...body } }), 201);
  return ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token }));
};

test('factures en retard : une seule notification groupée, envoyée selon le rôle, sans doublon', async () => {
  await invoice(); await invoice();
  assert.ok((await types(A)).includes('invoice_overdue'));
  const mine = (await list(A)).filter((n) => n.type === 'invoice_overdue');
  assert.equal(mine.length, 1, 'regroupées : une notification, pas une par facture'); assert.match(mine[0].title, /^2 factures clients en retard/);
  assert.equal(mine[0].link, '/sales/reminders'); assert.equal(mine[0].severity, 'critical'); assert.equal(mine[0].read, false);
  assert.ok((await types(accountant)).includes('invoice_overdue'));
  assert.ok((await types(sales)).includes('invoice_overdue'));
  assert.ok(!(await types(stockMgr)).includes('invoice_overdue'), 'le gestionnaire de stock ne gère pas les factures');
  assert.deepEqual(await types(readOnly), [], 'lecture seule : rien à faire, rien reçu');
  assert.equal(await scanCompany(await dbId(A.companyId)), 0, 'rejouer l\'analyse ne crée aucun doublon');
  assert.equal((await list(A)).filter((n) => n.type === 'invoice_overdue').length, 1);
});

test('stock bas et stock négatif : destinataires = gestionnaires de stock, propriétaire, administrateur', async () => {
  const wh = ok(await c('GET', '/stock/warehouses', { token: A.token }))[0];
  const p = ok(await c('POST', '/products', { token: A.token, body: { name: 'Câble test', sku: 'CAB-N', salePrice: '10.000', purchasePrice: '5.000', taxRateId: tax19.id, trackStock: true, stockAlertThreshold: '10' } }), 201);
  ok(await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: today, lines: [{ productId: p.id, quantity: 4, unitCost: '5.000' }] } }), 201);
  const n = (await list(stockMgr)).find((x) => x.type === 'low_stock');
  assert.ok(n, 'stock bas'); assert.match(n.body, /Câble test/); assert.equal(n.link, '/stock/inventory');
  assert.ok((await types(A)).includes('low_stock')); assert.ok((await types(admin)).includes('low_stock'));
  assert.ok(!(await types(accountant)).includes('low_stock')); assert.ok(!(await types(sales)).includes('low_stock'));
  await pool.query('INSERT INTO stock_levels (product_id, warehouse_id, company_id, quantity) SELECT p.id, w.id, p.company_id, -2 FROM products p JOIN warehouses w ON w.company_id = p.company_id WHERE p.public_id = ? LIMIT 1 ON DUPLICATE KEY UPDATE quantity = -2', [p.id]);
  assert.ok((await types(stockMgr)).includes('negative_stock'));
});

test('encaissement : notification au comptable et au propriétaire, avec le client et le montant', async () => {
  const inv = await invoice({ dueDate: plusDays(30), issueDate: today });
  ok(await c('POST', '/payments', { token: A.token, body: { clientId: client.id, date: today, method: 'cash', allocations: [{ invoiceId: inv.id, amount: inv.netPayable }] } }), 201);
  const n = (await list(accountant)).find((x) => x.type === 'payment_received');
  assert.ok(n); assert.match(n.title, /^Encaissement de 119,000 TND/); assert.match(n.body, /Client Notif/);
  assert.ok(!(await types(stockMgr)).includes('payment_received'));
});

test('lecture : marquer lu, tout marquer lu, compteur, filtre non lues', async () => {
  const before_ = ok(await c('GET', '/notifications/summary', { token: A.token }));
  assert.ok(before_.unread >= 2); assert.ok(before_.latest.length >= 1 && before_.latest.length <= 6);
  const first = (await list(A))[0];
  ok(await c('POST', `/notifications/${first.id}/read`, { token: A.token }));
  assert.equal(ok(await c('GET', '/notifications/summary', { token: A.token })).unread, before_.unread - 1);
  assert.ok(!(await list(A, '?status=unread')).some((n) => n.id === first.id));
  assert.equal((await c('POST', '/notifications/pas-un-id/read', { token: A.token })).status, 404);
  ok(await c('POST', '/notifications/read-all', { token: A.token }));
  assert.equal(ok(await c('GET', '/notifications/summary', { token: A.token })).unread, 0);
  assert.ok((await list(accountant, '?status=unread')).length > 0, 'le statut lu est personnel : le comptable garde ses non lues');
  assert.equal((await c('GET', '/notifications?limit=500', { token: A.token })).status, 400);
});

test('isolation : on ne lit ni ne modifie les notifications d\'un autre utilisateur ou d\'une autre entreprise', async () => {
  const mineOfAccountant = (await list(accountant))[0];
  assert.equal((await c('POST', `/notifications/${mineOfAccountant.id}/read`, { token: A.token })).status, 404, 'autre utilisateur, même entreprise');
  assert.equal((await c('POST', `/notifications/${mineOfAccountant.id}/read`, { token: B.token })).status, 404, 'autre entreprise');
  assert.deepEqual(await list(B), [], 'l\'entreprise B ne voit rien de A');
  assert.equal((await c('GET', '/notifications')).status, 401);
});

test('préférences : désactiver un type le masque (compteur compris), par utilisateur ; types non autorisés refusés', async () => {
  const prefs = ok(await c('GET', '/notifications/preferences', { token: stockMgr.token }));
  assert.ok(prefs.some((p) => p.type === 'low_stock' && p.enabled)); assert.ok(!prefs.some((p) => p.type === 'invoice_overdue'), 'seulement les types de son rôle');
  assert.ok(ok(await c('GET', '/notifications/preferences', { token: A.token })).some((p) => p.type === 'trial_ending'));
  assert.ok(!ok(await c('GET', '/notifications/preferences', { token: accountant.token })).some((p) => p.type === 'trial_ending'), 'abonnement : propriétaire et administrateur seulement');
  const unreadBefore = ok(await c('GET', '/notifications/summary', { token: stockMgr.token })).unread;
  assert.ok(unreadBefore > 0);
  ok(await c('PUT', '/notifications/preferences', { token: stockMgr.token, body: { preferences: { low_stock: false, negative_stock: false } } }));
  assert.deepEqual(await types(stockMgr), []); assert.equal(ok(await c('GET', '/notifications/summary', { token: stockMgr.token })).unread, 0);
  assert.ok((await types(A)).includes('low_stock'), 'les autres utilisateurs ne sont pas affectés');
  assert.equal((await c('PUT', '/notifications/preferences', { token: stockMgr.token, body: { preferences: { invoice_overdue: false } } })).status, 422);
  assert.equal((await c('PUT', '/notifications/preferences', { token: stockMgr.token, body: { preferences: { nimporte: true } } })).status, 422);
  assert.equal((await c('PUT', '/notifications/preferences', { token: stockMgr.token, body: { preferences: { low_stock: 'oui' } } })).status, 400);
  ok(await c('PUT', '/notifications/preferences', { token: stockMgr.token, body: { preferences: { low_stock: true } } }));
  assert.ok((await types(stockMgr)).includes('low_stock'), 'réactivé : l\'historique réapparaît');
});

test('abonnement : fin d\'essai (propriétaire et administrateur), puis expiré ; marquer lu reste possible en lecture seule', async () => {
  const id = await dbId(A.companyId);
  await pool.query("UPDATE company_subscriptions SET status='trial', trial_ends_at=? WHERE company_id=?", [`${plusDays(2)} 23:59:59`, id]);
  const n = (await list(A)).find((x) => x.type === 'trial_ending'); assert.ok(n); assert.match(n.title, /dans 2 jours/); assert.equal(n.link, '/subscription/pay');
  assert.ok((await types(admin)).includes('trial_ending')); assert.ok(!(await types(accountant)).includes('trial_ending'));
  await pool.query("UPDATE company_subscriptions SET trial_ends_at=? WHERE company_id=?", [`${plusDays(-2)} 23:59:59`, id]);
  assert.ok((await types(A)).includes('subscription_expired'));
  assert.equal((await c('POST', '/clients', { token: A.token, body: { name: 'Bloqué' } })).status, 403, 'données métier en lecture seule');
  ok(await c('POST', '/notifications/read-all', { token: A.token }));
  assert.equal(ok(await c('GET', '/notifications/summary', { token: A.token })).unread, 0);
  await pool.query("UPDATE company_subscriptions SET status='active', trial_ends_at=NULL, current_period_end=NULL WHERE company_id=?", [id]);
});

test('abonnement : paiement confirmé ou refusé par l\'éditeur → notification au propriétaire', async () => {
  const id = await dbId(A.companyId);
  const [[plan]] = await pool.query("SELECT id FROM subscription_plans WHERE code = 'pro'");
  await pool.query("INSERT INTO subscription_payments (public_id, company_id, plan_id, period, amount, currency, reference, paid_on, status, review_note, reviewed_at) VALUES (UUID(), ?, ?, 'yearly', 560, 'TND', 'MHFAC-TEST0001', ?, 'rejected', 'Montant reçu incorrect', UTC_TIMESTAMP())", [id, plan.id, today]);
  const n = (await list(A)).find((x) => x.type === 'subscription_payment'); assert.ok(n); assert.equal(n.severity, 'critical'); assert.match(n.body, /Montant reçu incorrect/);
  assert.ok(!(await types(sales)).includes('subscription_payment'));
});
