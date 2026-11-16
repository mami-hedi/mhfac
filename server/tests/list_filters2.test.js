import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, readOnly, client, sup, tax19, prod;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const csv = async (path, token) => { const r = await fetch(`${app.base}${path}`, { headers: { authorization: `Bearer ${token}` } }); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, text: buf.toString('utf8'), bom: buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), headers: r.headers }; };
const L = (p, q, price, desc) => ({ productId: p?.id, description: desc ?? p?.name ?? 'Prestation', quantity: q, unitPrice: price, taxRateId: tax19.id });
const ids = async (path, qs, token = A.token) => ok(await c('GET', `${path}?${qs}`, { token })).map((d) => d.id);

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Filtres2 A'); B = await registerCompany(app.call, 'Filtres2 B'); readOnly = await addMember(app.call, A, 'read_only');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Deux' } }), 201);
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Deux' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
  prod = ok(await c('POST', '/products', { token: A.token, body: { name: 'Imprimante laser', salePrice: '300', taxRateId: tax19.id, trackStock: true } }), 201);
});
after(() => app.close());

test('devis et commandes : période, montant TTC, produit, recherche lignes/notes, export CSV', async () => {
  const q1 = ok(await c('POST', '/quotes', { token: A.token, body: { clientId: client.id, issueDate: '2026-06-02', validUntil: '2026-12-31', notes: 'Offre salon professionnel', lines: [L(prod, 1, '300')] } }), 201); // 357
  const q2 = ok(await c('POST', '/quotes', { token: A.token, body: { clientId: client.id, issueDate: '2026-06-20', validUntil: '2026-12-31', lines: [L(null, 2, '10', 'Maintenance annuelle')] } }), 201); // 23,8
  assert.deepEqual(await ids('/quotes', 'from=2026-06-01&to=2026-06-30'), [q2.id, q1.id], 'plus récent en premier');
  assert.deepEqual(await ids('/quotes', 'minAmount=100'), [q1.id]); assert.deepEqual(await ids('/quotes', 'maxAmount=50'), [q2.id]);
  assert.deepEqual(await ids('/quotes', `productId=${prod.id}`), [q1.id]); assert.deepEqual(await ids('/quotes', 'q=salon'), [q1.id]); assert.deepEqual(await ids('/quotes', 'q=maintenance'), [q2.id]);
  const e = await csv('/quotes/export?from=2026-06-01&to=2026-06-30', A.token); assert.equal(e.status, 200); assert.ok(e.bom);
  const lines = e.text.trim().split('\r\n'); assert.equal(lines.length, 3); assert.ok(lines[0].includes('Validité')); assert.ok(lines[1].includes('20/06/2026')); assert.ok(lines.some((l) => l.includes('357,000')));
  assert.equal((await csv('/quotes/export', B.token)).text.trim().split('\r\n').length, 1, 'isolation');
  const o1 = ok(await c('POST', '/orders', { token: A.token, body: { clientId: client.id, issueDate: '2026-07-05', lines: [L(prod, 2, '300')] } }), 201);
  assert.deepEqual(await ids('/orders', `productId=${prod.id}&minAmount=500`), [o1.id]); assert.deepEqual(await ids('/orders', 'from=2026-07-06'), []);
  const eo = await csv('/orders/export', A.token); assert.equal(eo.status, 200); assert.ok(eo.text.includes('714,000'));
  assert.equal((await c('GET', '/quotes?from=2026-07-01&to=2026-06-01', { token: A.token })).status, 422);
});

test('achats : commandes d\'achat, bons de réception, filtres et export', async () => {
  const po = ok(await c('POST', '/purchase-orders', { token: A.token, body: { supplierId: sup.id, issueDate: '2026-08-03', notes: 'Livraison port Radès', lines: [L(prod, 4, '200')] } }), 201); // 952
  assert.deepEqual(await ids('/purchase-orders', 'minAmount=900'), [po.id]); assert.deepEqual(await ids('/purchase-orders', 'q=Rad%C3%A8s'), [po.id]); assert.deepEqual(await ids('/purchase-orders', `productId=${prod.id}`), [po.id]);
  const e = await csv('/purchase-orders/export', A.token); assert.equal(e.status, 200); assert.ok(e.text.includes('952,000')); assert.ok(e.text.includes('Fournisseur Deux'));
  ok(await c('POST', `/purchase-orders/${po.id}/confirm`, { token: A.token }));
  const rc = ok(await c('POST', '/purchase-receipts', { token: A.token, body: { orderId: po.id, receiptDate: '2026-08-04', lines: [{ orderLineId: ok(await c('GET', `/purchase-orders/${po.id}`, { token: A.token })).lines[0].id, quantity: 4 }] } }), 201);
  assert.deepEqual(await ids('/purchase-receipts', 'from=2026-08-01&to=2026-08-31'), [rc.id]); assert.deepEqual(await ids('/purchase-receipts', `productId=${prod.id}`), [rc.id]);
  const er = await csv('/purchase-receipts/export', A.token); assert.equal(er.status, 200); assert.ok(er.text.includes('Fournisseur Deux'));
  assert.equal((await csv('/purchase-orders/export', readOnly.token)).status, 403 - 403 + 200, 'lecture seule : peut lire donc exporter');
});

test('bons de livraison, bons de stock, retours, règlements : export et filtres de période', async () => {
  const wh = ok(await c('GET', '/stock/warehouses', { token: A.token }))[0];
  const ent = ok(await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: '2026-09-02', reason: 'Réassort', lines: [{ productId: prod.id, quantity: 10, unitCost: '150.000' }] } }), 201); ok(await c('POST', `/stock/entries/${ent.id}/validate`, { token: A.token }));
  assert.deepEqual(await ids('/stock/entries', 'from=2026-09-01&to=2026-09-30'), [ent.id]); assert.deepEqual(await ids('/stock/entries', `productId=${prod.id}`), [ent.id]); assert.deepEqual(await ids('/stock/entries', 'q=R%C3%A9assort'), [ent.id]);
  assert.deepEqual(await ids('/stock/entries', 'from=2026-10-01'), []);
  const ee = await csv('/stock/entries/export', A.token); assert.equal(ee.status, 200); assert.ok(ee.text.includes('02/09/2026'));
  for (const path of ['/delivery-notes/export', '/sales-returns/export', '/purchase-returns/export', '/payments/export', '/supplier-payments/export', '/stock/withdrawals/export', '/stock/transfers/export']) {
    const r = await csv(path, A.token); assert.equal(r.status, 200, path); assert.ok(r.bom, path); assert.equal((await csv(path, B.token)).text.trim().split('\r\n').length, 1, `${path} isolé`);
  }
  assert.equal((await fetch(`${app.base}/payments/export`)).status, 401);
  assert.equal((await c('GET', '/payments?minAmount=abc', { token: A.token })).status, 400);
  assert.equal((await c('GET', '/delivery-notes?limit=15', { token: A.token })).body.meta.limit, 15);
});
