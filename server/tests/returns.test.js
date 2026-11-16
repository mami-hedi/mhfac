import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, readOnly, client, sup, tax19, prod, wh;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const level = async () => ok(await c('GET', `/stock/levels?q=${encodeURIComponent(prod.name)}`, { token: A.token })).find((x) => x.productId === prod.id);
const qty = async () => Number((await level())?.quantity ?? 0);
const L = (q, price = '100') => ({ productId: prod.id, description: prod.name, quantity: q, unitPrice: price, taxRateId: tax19.id });

async function deliver(q) {
  const o = ok(await c('POST', '/orders', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [L(q)] } }), 201);
  ok(await c('POST', `/orders/${o.id}/confirm`, { token: A.token }));
  const full = ok(await c('GET', `/orders/${o.id}`, { token: A.token }));
  const bl = ok(await c('POST', '/delivery-notes', { token: A.token, body: { orderId: o.id, warehouseId: wh.id, deliveryDate: today, lines: [{ orderLineId: full.lines[0].id, quantity: q }] } }), 201);
  return ok(await c('POST', `/delivery-notes/${bl.id}/validate`, { token: A.token }));
}
async function receive(q, price = '60') {
  const o = ok(await c('POST', '/purchase-orders', { token: A.token, body: { supplierId: sup.id, issueDate: today, lines: [L(q, price)] } }), 201);
  const full = ok(await c('POST', `/purchase-orders/${o.id}/confirm`, { token: A.token }));
  const r = ok(await c('POST', '/purchase-receipts', { token: A.token, body: { orderId: o.id, warehouseId: wh.id, receiptDate: today, lines: [{ orderLineId: full.lines[0].id, quantity: q }] } }), 201);
  return ok(await c('POST', `/purchase-receipts/${r.id}/validate`, { token: A.token }));
}

before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Retours A'); B = await registerCompany(app.call, 'Retours B');
  readOnly = await addMember(app.call, A, 'read_only');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Retour' } }), 201);
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Retour' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
  prod = ok(await c('POST', '/products', { token: A.token, body: { name: 'Écran retour', salePrice: '300', taxRateId: tax19.id, trackStock: true } }), 201);
  wh = ok(await c('GET', '/stock/warehouses', { token: A.token }))[0];
  const e = ok(await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: today, lines: [{ productId: prod.id, quantity: 10, unitCost: '80' }] } }), 201);
  ok(await c('POST', `/stock/entries/${e.id}/validate`, { token: A.token }));
});
after(() => app.close());

test('retour client : quantités plafonnées, remise en stock au coût de sortie, idempotence', async () => {
  const bl = await deliver(6); assert.equal(await qty(), 4);
  const info = ok(await c('GET', `/sales-returns/source/${bl.id}`, { token: A.token }));
  assert.equal(info.lines[0].returnableQuantity, '6.0000');
  const lineId = info.lines[0].id;
  const mk = (q, extra = {}) => c('POST', '/sales-returns', { token: A.token, body: { sourceId: bl.id, returnDate: today, reason: 'Produit défectueux', lines: [{ sourceLineId: lineId, quantity: q }], ...extra } });
  assert.equal((await mk(7)).status, 422, 'plus que livré');
  const r = ok(await mk(2), 201); assert.equal(r.status, 'draft'); assert.equal(r.number, null);
  assert.equal(await qty(), 4, 'un brouillon ne bouge pas le stock');
  assert.equal((await mk(5)).status, 422, 'le brouillon réserve 2 : reste 4');
  const v = ok(await c('POST', `/sales-returns/${r.id}/validate`, { token: A.token })); assert.match(v.number, /^BRT-\d{4}-\d{5}$/);
  assert.equal(await qty(), 6); assert.equal((await level()).avgCost, '80.0000', 'coût d\'origine conservé');
  assert.equal((await c('POST', `/sales-returns/${r.id}/validate`, { token: A.token })).status, 409);
  assert.equal(ok(await c('GET', `/sales-returns/source/${bl.id}`, { token: A.token })).lines[0].returnableQuantity, '4.0000');
  assert.equal((await c('POST', `/delivery-notes/${bl.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } })).status, 409, 'livraison avec retour');
  assert.equal((await c('PUT', `/sales-returns/${r.id}`, { token: A.token, body: { returnDate: today, reason: 'x y z', lines: [{ sourceLineId: lineId, quantity: 1 }] } })).status, 409, 'validé = figé');
  assert.equal((await c('DELETE', `/sales-returns/${r.id}`, { token: A.token })).status, 409);
  const cx = ok(await c('POST', `/sales-returns/${r.id}/cancel`, { token: A.token, body: { reason: 'Retour refusé' } })); assert.equal(cx.status, 'cancelled');
  assert.equal(await qty(), 4, 'stock rétabli par mouvement inverse');
  assert.equal((await c('POST', `/sales-returns/${r.id}/cancel`, { token: A.token, body: { reason: 'Encore une fois' } })).status, 409);
  ok(await c('POST', `/delivery-notes/${bl.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } }));
});

test('retour client : isolation, droits, brouillon modifiable/supprimable, livraison non validée refusée', async () => {
  const bl = await deliver(2);
  const lineId = ok(await c('GET', `/sales-returns/source/${bl.id}`, { token: A.token })).lines[0].id;
  const body = { sourceId: bl.id, returnDate: today, reason: 'Erreur de commande', lines: [{ sourceLineId: lineId, quantity: 1 }] };
  assert.equal((await c('POST', '/sales-returns', { token: readOnly.token, body })).status, 403);
  assert.equal((await c('POST', '/sales-returns', { token: B.token, body })).status, 404, 'document d\'une autre société');
  const r = ok(await c('POST', '/sales-returns', { token: A.token, body }), 201);
  assert.equal((await c('GET', `/sales-returns/${r.id}`, { token: B.token })).status, 404);
  assert.equal((await c('GET', `/sales-returns/${r.id}`, { token: readOnly.token })).status, 200);
  const up = ok(await c('PUT', `/sales-returns/${r.id}`, { token: A.token, body: { returnDate: today, reason: 'Motif corrigé', lines: [{ sourceLineId: lineId, quantity: 2 }] } }));
  assert.equal(up.lines[0].quantity, '2.0000'); assert.equal(up.reason, 'Motif corrigé');
  assert.equal((await c('DELETE', `/sales-returns/${r.id}`, { token: A.token })).status, 204);
  const list = ok(await c('GET', '/sales-returns', { token: A.token })); assert.ok(Array.isArray(list));
  const hist = ok(await c('GET', `/sales-returns/${(ok(await c('POST', '/sales-returns', { token: A.token, body }), 201)).id}/history`, { token: A.token })); assert.ok(hist.length >= 1);
});

test('retour fournisseur : sortie de stock au coût moyen, plafond, annulation, réception verrouillée', async () => {
  const before0 = await qty();
  const rc = await receive(10, '60'); assert.equal(await qty(), before0 + 10);
  const info = ok(await c('GET', `/purchase-returns/source/${rc.id}`, { token: A.token })); const lineId = info.lines[0].id;
  const mk = (q) => c('POST', '/purchase-returns', { token: A.token, body: { sourceId: rc.id, returnDate: today, reason: 'Non conforme', lines: [{ sourceLineId: lineId, quantity: q }] } });
  assert.equal((await mk(11)).status, 422);
  const r = ok(await mk(3), 201);
  assert.equal(await qty(), before0 + 10, 'brouillon sans effet');
  const v = ok(await c('POST', `/purchase-returns/${r.id}/validate`, { token: A.token })); assert.match(v.number, /^RF-\d{4}-\d{5}$/);
  assert.equal(await qty(), before0 + 7);
  assert.equal((await c('POST', `/purchase-receipts/${rc.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } })).status, 409, 'réception avec retour');
  assert.equal(ok(await c('GET', `/purchase-returns/source/${rc.id}`, { token: A.token })).lines[0].returnableQuantity, '7.0000');
  ok(await c('POST', `/purchase-returns/${r.id}/cancel`, { token: A.token, body: { reason: 'Retour annulé' } }));
  assert.equal(await qty(), before0 + 10, 'stock remis');
  assert.equal((await c('POST', '/purchase-returns', { token: readOnly.token, body: { sourceId: rc.id, returnDate: today, reason: 'Interdit', lines: [{ sourceLineId: lineId, quantity: 1 }] } })).status, 403);
});

test('retour fournisseur : stock insuffisant refusé quand le stock négatif est désactivé', async () => {
  const rc = await receive(4, '60');
  const lineId = ok(await c('GET', `/purchase-returns/source/${rc.id}`, { token: A.token })).lines[0].id;
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { stock: { allowNegative: false } } });
  try {
    const cur = await qty();
    const r = ok(await c('POST', '/purchase-returns', { token: A.token, body: { sourceId: rc.id, returnDate: today, reason: 'Retour total', lines: [{ sourceLineId: lineId, quantity: 4 }] } }), 201);
    // on vide le stock restant par un bon de prélèvement pour provoquer le refus
    const w = ok(await c('POST', '/stock/withdrawals', { token: A.token, body: { warehouseId: wh.id, date: today, reason: 'Casse', lines: [{ productId: prod.id, quantity: cur }] } }), 201);
    ok(await c('POST', `/stock/withdrawals/${w.id}/validate`, { token: A.token }));
    const bad = await c('POST', `/purchase-returns/${r.id}/validate`, { token: A.token });
    assert.equal(bad.status, 409); assert.equal(bad.body.error.code, 'STOCK_INSUFFICIENT');
  } finally { await c('PATCH', '/companies/current/settings', { token: A.token, body: { stock: { allowNegative: true } } }); }
});
