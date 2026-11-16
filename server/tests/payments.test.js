import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, accountant, readOnly, sales, client, client2, tax19;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());

async function issued(token, cl, price = '100.000', qty = 1) {
  const d = await c('POST', '/invoices', { token, body: { clientId: cl.id, issueDate: today, lines: [{ description: 'Prestation', quantity: qty, unitPrice: price, taxRateId: tax19.id }] } });
  assert.equal(d.status, 201, d.raw);
  const i = await c('POST', `/invoices/${d.body.data.id}/issue`, { token });
  assert.equal(i.status, 200, i.raw);
  return i.body.data; // 100 HT -> 119 TTC
}
const pay = (token, body) => c('POST', '/payments', { token, body: { date: today, method: 'cash', ...body } });

before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Alpha'); B = await registerCompany(app.call, 'Beta');
  accountant = await addMember(app.call, A, 'accountant'); readOnly = await addMember(app.call, A, 'read_only'); sales = await addMember(app.call, A, 'sales');
  client = (await c('POST', '/clients', { token: A.token, body: { name: 'Client Payeur' } })).body.data;
  client2 = (await c('POST', '/clients', { token: A.token, body: { name: 'Autre Client' } })).body.data;
  tax19 = (await c('GET', '/tax-rates', { token: A.token })).body.data.find((t) => t.rate === '19.00');
});
after(() => app.close());

test('règlement partiel puis solde : paid_amount, statuts et numérotation REG', async () => {
  const inv = await issued(A.token, client);
  assert.equal(inv.netPayable, '119.000');
  const p1 = await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '50' }], reference: 'CHQ-001', method: 'cheque' });
  assert.equal(p1.status, 201, p1.raw);
  assert.match(p1.body.data.number, /^REG-\d{4}-00001$/);
  let d = (await c('GET', `/invoices/${inv.id}`, { token: A.token })).body.data;
  assert.equal(d.paidAmount, '50.000'); assert.equal(d.paymentStatus, 'partial'); assert.equal(d.balance, '69.000');
  assert.equal(d.payments.length, 1);
  const p2 = await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '69,000' }] });
  assert.equal(p2.status, 201); assert.match(p2.body.data.number, /00002$/);
  d = (await c('GET', `/invoices/${inv.id}`, { token: A.token })).body.data;
  assert.equal(d.paymentStatus, 'paid'); assert.equal(d.balance, '0.000');
  const list = await c('GET', '/payments?q=CHQ', { token: A.token });
  assert.equal(list.body.data.length, 1);
});

test('refus : sur-paiement, autre client, brouillon, date future, montant invalide, facture inconnue', async () => {
  const inv = await issued(A.token, client);
  assert.equal((await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '119.001' }] })).body.error.code, 'OVERPAYMENT');
  assert.equal((await pay(A.token, { clientId: client2.id, allocations: [{ invoiceId: inv.id, amount: '10' }] })).body.error.code, 'CLIENT_MISMATCH');
  const draft = (await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ description: 'x', quantity: 1, unitPrice: 10, taxRateId: tax19.id }] } })).body.data;
  assert.equal((await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: draft.id, amount: '5' }] })).body.error.code, 'INVALID_STATE');
  assert.equal((await pay(A.token, { clientId: client.id, date: '2999-01-01', allocations: [{ invoiceId: inv.id, amount: '5' }] })).body.error.code, 'FUTURE_DATE');
  assert.equal((await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '0' }] })).status, 400);
  assert.equal((await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '-5' }] })).status, 400);
  assert.equal((await pay(A.token, { clientId: client.id, allocations: [] })).status, 400);
  assert.equal((await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: '11111111-1111-4111-8111-111111111111', amount: '5' }] })).status, 422);
  assert.equal((await pay(A.token, { clientId: client.id, method: 'bitcoin', allocations: [{ invoiceId: inv.id, amount: '5' }] })).status, 400);
  const dup = await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '5' }, { invoiceId: inv.id, amount: '5' }] });
  assert.equal(dup.status, 422);
});

test('un règlement sur plusieurs factures ; annulation rétablit les soldes ; règlement conservé', async () => {
  const i1 = await issued(A.token, client); const i2 = await issued(A.token, client);
  const p = await pay(A.token, { clientId: client.id, method: 'bank_transfer', allocations: [{ invoiceId: i1.id, amount: '119' }, { invoiceId: i2.id, amount: '19' }] });
  assert.equal(p.status, 201, p.raw); assert.equal(p.body.data.amount, '138.000'); assert.equal(p.body.data.allocations.length, 2);
  assert.equal((await c('POST', `/invoices/${i1.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } })).body.error.code, 'HAS_PAYMENTS');
  assert.equal((await c('POST', `/payments/${p.body.data.id}/cancel`, { token: sales.token, body: { reason: 'Chèque rejeté' } })).status, 403);
  assert.equal((await c('POST', `/payments/${p.body.data.id}/cancel`, { token: accountant.token, body: { reason: 'x' } })).status, 400);
  const cx = await c('POST', `/payments/${p.body.data.id}/cancel`, { token: accountant.token, body: { reason: 'Chèque rejeté' } });
  assert.equal(cx.status, 200); assert.equal(cx.body.data.status, 'cancelled');
  assert.equal((await c('POST', `/payments/${p.body.data.id}/cancel`, { token: accountant.token, body: { reason: 'Chèque rejeté' } })).status, 409);
  const d = (await c('GET', `/invoices/${i1.id}`, { token: A.token })).body.data;
  assert.equal(d.paidAmount, '0.000'); assert.equal(d.paymentStatus, 'unpaid');
  assert.equal((await c('GET', `/payments/${p.body.data.id}`, { token: A.token })).body.data.cancelReason, 'Chèque rejeté');
  const h = await c('GET', `/payments/${p.body.data.id}/history`, { token: A.token });
  assert.ok(h.body.data.some((x) => x.action === 'payment.cancel'));
});

test('avoir + règlement : le solde tient compte des avoirs émis', async () => {
  const inv = await issued(A.token, client);
  const cn = (await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: inv.id, reason: 'Remise', lines: [{ invoiceLineId: inv.lines[0].id, quantity: '0.5' }] } })).body.data;
  await c('POST', `/credit-notes/${cn.id}/issue`, { token: A.token });
  const d = (await c('GET', `/invoices/${inv.id}`, { token: A.token })).body.data;
  assert.equal(d.balance, '59.500');
  assert.equal((await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '60' }] })).body.error.code, 'OVERPAYMENT');
  assert.equal((await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '59.5' }] })).status, 201);
  assert.equal((await c('GET', `/invoices/${inv.id}`, { token: A.token })).body.data.paymentStatus, 'paid');
});

test('permissions et isolation', async () => {
  const inv = await issued(A.token, client);
  assert.equal((await pay(readOnly.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '5' }] })).status, 403);
  assert.equal((await c('GET', '/payments', { token: readOnly.token })).status, 200);
  assert.equal((await c('GET', '/payments')).status, 401);
  const clientB = (await c('POST', '/clients', { token: B.token, body: { name: 'Client B' } })).body.data;
  assert.equal((await pay(B.token, { clientId: clientB.id, allocations: [{ invoiceId: inv.id, amount: '5' }] })).status, 422);
  assert.equal((await pay(B.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '5' }] })).status, 422);
  const p = await pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '5' }] });
  assert.equal((await c('GET', `/payments/${p.body.data.id}`, { token: B.token })).status, 404);
  assert.equal((await c('POST', `/payments/${p.body.data.id}/cancel`, { token: B.token, body: { reason: 'Intrusion' } })).status, 404);
  assert.equal((await c('GET', '/invoices?open=1', { token: A.token })).body.data.every((x) => x.status === 'issued'), true);
});

test('règlements simultanés sur la même facture : jamais de sur-paiement', async () => {
  const inv = await issued(A.token, client); // 119
  const rs = await Promise.all(Array.from({ length: 4 }, () => pay(A.token, { clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '60' }] })));
  const ok = rs.filter((r) => r.status === 201).length;
  assert.equal(ok, 1, JSON.stringify(rs.map((r) => r.status)));
  const d = (await c('GET', `/invoices/${inv.id}`, { token: A.token })).body.data;
  assert.equal(d.paidAmount, '60.000');
});
