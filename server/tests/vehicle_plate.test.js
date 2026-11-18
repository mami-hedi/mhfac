import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany } from './helpers.js';

let app, A, client, sup, tax19, prod, wh;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Matricule SARL');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Matricule' } }), 201);
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Matricule' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
  prod = ok(await c('POST', '/products', { token: A.token, body: { name: 'Article matricule', salePrice: '10', taxRateId: tax19.id, trackStock: true } }), 201);
  wh = ok(await c('GET', '/stock/warehouses', { token: A.token }))[0];
});
after(() => app.close());

test('bon de livraison : matricule du véhicule normalisé, modifiable en brouillon, vide = null', async () => {
  const o = ok(await c('POST', '/orders', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ description: 'Marchandise', quantity: 5, unitPrice: '10', taxRateId: tax19.id }] } }), 201);
  const co = ok(await c('POST', `/orders/${o.id}/confirm`, { token: A.token }));
  const body = (extra) => ({ orderId: co.id, deliveryDate: today, lines: [{ orderLineId: co.lines[0].id, quantity: 2 }], ...extra });
  const bl = ok(await c('POST', '/delivery-notes', { token: A.token, body: body({ vehiclePlate: '  123 tun   4567 ' }) }), 201);
  assert.equal(bl.vehiclePlate, '123 TUN 4567');
  const upd = ok(await c('PUT', `/delivery-notes/${bl.id}`, { token: A.token, body: body({ vehiclePlate: '' }) }));
  assert.equal(upd.vehiclePlate, null);
  assert.equal((await c('PUT', `/delivery-notes/${bl.id}`, { token: A.token, body: body({ vehiclePlate: 'X'.repeat(21) }) })).status, 400, '20 caractères max');
  ok(await c('PUT', `/delivery-notes/${bl.id}`, { token: A.token, body: body({ vehiclePlate: '200 TUN 1' }) }));
  ok(await c('POST', `/delivery-notes/${bl.id}/validate`, { token: A.token }));
  assert.equal(ok(await c('GET', `/delivery-notes/${bl.id}`, { token: A.token })).vehiclePlate, '200 TUN 1');
  assert.equal((await c('PUT', `/delivery-notes/${bl.id}`, { token: A.token, body: body({ vehiclePlate: '999 TUN 9' }) })).status, 409, 'validé = verrouillé');
});

test('bon de réception : matricule enregistré et relu', async () => {
  const po = ok(await c('POST', '/purchase-orders', { token: A.token, body: { supplierId: sup.id, issueDate: today, lines: [{ description: 'Achat', quantity: 3, unitPrice: '5', taxRateId: tax19.id }] } }), 201);
  const co = ok(await c('POST', `/purchase-orders/${po.id}/confirm`, { token: A.token }));
  const r = ok(await c('POST', '/purchase-receipts', { token: A.token, body: { orderId: co.id, receiptDate: today, vehiclePlate: '88 tun 12', lines: [{ orderLineId: co.lines[0].id, quantity: 3 }] } }), 201);
  assert.equal(r.vehiclePlate, '88 TUN 12');
  assert.equal(ok(await c('GET', `/purchase-receipts/${r.id}`, { token: A.token })).vehiclePlate, '88 TUN 12');
});

test('bon de transfert : matricule conservé ; ignoré pour entrée et prélèvement', async () => {
  const wh2 = ok(await c('POST', '/stock/warehouses', { token: A.token, body: { code: 'DEP2', name: 'Dépôt 2', address: '12 rue de l\'Industrie, 1002 Tunis' } }), 201);
  const e = ok(await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: today, lines: [{ productId: prod.id, quantity: 5, unitCost: '3' }] } }), 201);
  ok(await c('POST', `/stock/entries/${e.id}/validate`, { token: A.token }));
  const t = ok(await c('POST', '/stock/transfers', { token: A.token, body: { warehouseId: wh.id, toWarehouseId: wh2.id, date: today, vehiclePlate: '55 tun 6', lines: [{ productId: prod.id, quantity: 2 }] } }), 201);
  assert.equal(t.vehiclePlate, '55 TUN 6');
  assert.equal(t.toWarehouse.address, '12 rue de l\'Industrie, 1002 Tunis', 'adresse de destination exposée pour le bon de transfert');
  assert.ok('address' in t.warehouse);
  const e2 = ok(await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: today, vehiclePlate: '1 TUN 1', lines: [{ productId: prod.id, quantity: 1, unitCost: '3' }] } }), 201);
  assert.equal(e2.vehiclePlate, null);
  const pdf = await fetch(`${app.base}/stock/transfers/${t.id}/pdf`, { headers: { authorization: `Bearer ${A.token}` } });
  assert.equal(pdf.status, 200);
});

test('disponibilité par article pour les documents de vente : signale le stock insuffisant', async () => {
  const r = ok(await c('POST', '/stock/availability', { token: A.token, body: { lines: [{ productId: prod.id, quantity: 999 }] } }));
  assert.equal(r.hasShortage, true); assert.equal(r.items[0].insufficient, true);
  const fine = ok(await c('POST', '/stock/availability', { token: A.token, body: { lines: [{ productId: prod.id, quantity: 1 }] } }));
  assert.equal(fine.hasShortage, false);
  assert.equal((await fetch(`${app.base}/stock/availability`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});
