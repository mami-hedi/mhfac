import test from 'node:test';
import assert from 'node:assert/strict';
import { addMember, registerCompany, startApp, uniqueEmail } from './helpers.js';

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

test('dashboard : equipe reelle, indicateurs calcules depuis les donnees (zero sur une entreprise vide)', async () => {
  const owner = await registerCompany(app.call);
  await app.call('POST', '/users/invitations', { token: owner.token, body: { email: uniqueEmail(), roleCode: 'sales' } });
  const r = await app.call('GET', '/dashboard/summary', { token: owner.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.team, { members: 1, pendingInvitations: 1 });
  const k = r.body.data.kpis;
  for (const key of ['revenue', 'collected', 'unpaid', 'overdue', 'pending_quotes', 'quote_conversion', 'expenses', 'client_balances', 'supplier_balances', 'treasury', 'low_stock']) assert.ok(key in k, key);
  assert.equal(k.revenue.value, '0.000'); assert.equal(k.quote_conversion.value, null, 'pas de taux sans devis décidés'); assert.equal(k.treasury.value, '0.000');
  assert.equal(r.body.data.charts.revenueTrend.length, 12);
});

test('dashboard : un gestionnaire de stock ne voit ni equipe ni indicateurs de facturation', async () => {
  const owner = await registerCompany(app.call);
  const stock = await addMember(app.call, owner, 'stock_manager');
  const r = await app.call('GET', '/dashboard/summary', { token: stock.token });
  assert.equal(r.body.data.team, null);
  const keys = Object.keys(r.body.data.kpis);
  assert.ok(keys.includes('low_stock'));
  assert.ok(!keys.includes('revenue') && !keys.includes('unpaid'));
  assert.equal((await app.call('GET', '/dashboard/summary')).status, 401);
});

test('dashboard : chiffres réels (CA, impayés, encaissé, dépenses, trésorerie) et filtre de période', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
  const o = await registerCompany(app.call); const call = app.call; const t = o.token;
  const cl = (await call('POST', '/clients', { token: t, body: { name: 'Client Dash' } })).body.data; const sp = (await call('POST', '/suppliers', { token: t, body: { name: 'Fourn Dash' } })).body.data;
  const tax = (await call('GET', '/tax-rates', { token: t })).body.data.find((x) => x.rate === '19.00');
  const mk = async (price, extra = {}) => { const d = (await call('POST', '/invoices', { token: t, body: { clientId: cl.id, issueDate: today, lines: [{ description: 'P', quantity: 1, unitPrice: price, taxRateId: tax.id }], ...extra } })).body.data; return (await call('POST', `/invoices/${d.id}/issue`, { token: t })).body.data; };
  const i1 = await mk('1000'); await mk('500', { issueDate: '2020-01-10', dueDate: '2020-02-10' });
  await call('POST', '/payments', { token: t, body: { clientId: cl.id, date: today, method: 'cash', allocations: [{ invoiceId: i1.id, amount: '400' }] } });
  const pi = (await call('POST', '/purchase-invoices', { token: t, body: { supplierId: sp.id, issueDate: today, supplierRef: 'D-1', lines: [{ description: 'A', quantity: 1, unitPrice: '300', taxRateId: tax.id }] } })).body.data; await call('POST', `/purchase-invoices/${pi.id}/record`, { token: t });
  await call('POST', '/treasury/accounts', { token: t, body: { code: 'C1', name: 'Caisse', type: 'cash', openingBalance: '250' } });
  const k = (await call('GET', '/dashboard/summary', { token: t })).body.data;
  assert.equal(k.kpis.revenue.value, '1000.000'); assert.equal(k.kpis.collected.value, '400.000'); assert.equal(k.kpis.expenses.value, '300.000');
  assert.equal(k.kpis.unpaid.count, 2); assert.equal(k.kpis.unpaid.value, `${(1190 - 400 + 595).toFixed(3)}`); assert.equal(k.kpis.overdue.count, 1); assert.equal(k.kpis.overdue.value, '595.000');
  assert.equal(k.kpis.supplier_balances.value, '357.000'); assert.equal(k.kpis.treasury.value, '250.000');
  assert.equal(k.charts.salesByClient[0].label, 'Client Dash'); assert.equal(k.charts.revenueTrend.at(-1).value, '1000.000');
  assert.deepEqual(k.charts.paidVsUnpaid.map((x) => x.label), ['Payé', 'Impayé']);
  const old = (await call('GET', '/dashboard/summary?from=2020-01-01&to=2020-12-31', { token: t })).body.data; assert.equal(old.kpis.revenue.value, '500.000');
  assert.equal((await call('GET', '/dashboard/summary?from=x', { token: t })).status, 400);
  const other = await registerCompany(app.call); assert.equal((await call('GET', '/dashboard/summary', { token: other.token })).body.data.kpis.revenue.value, '0.000', 'isolation');
});
