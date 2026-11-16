import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany } from './helpers.js';

let app, A, sup, tax19, prod, plain;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const level = async () => (ok(await c('GET', `/stock/levels?q=${encodeURIComponent(prod.name)}`, { token: A.token }))).find((x) => x.productId === prod.id);
let n = 0; const ref = () => `SE-${Date.now()}-${++n}`;
const inv = (lines, extra = {}) => c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: ref(), lines, ...extra } });
const L = (p, q, price) => ({ productId: p.id, description: p.name, quantity: q, unitPrice: price, taxRateId: tax19.id });

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Stock Facture');
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Stock' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
  prod = ok(await c('POST', '/products', { token: A.token, body: { name: 'Souris stock', salePrice: '100', taxRateId: tax19.id, trackStock: true } }), 201);
  plain = ok(await c('POST', '/products', { token: A.token, body: { name: 'Transport', salePrice: '10', taxRateId: tax19.id } }), 201);
});
after(() => app.close());

test('facture d\'achat avec « entrer en stock » : entrée à l\'enregistrement, coût, annulation inverse', async () => {
  // sans la case : aucune écriture de stock (comportement d'origine)
  const a = ok(await inv([L(prod, 5, '20')]), 201); assert.equal(a.stockEntry, false); ok(await c('POST', `/purchase-invoices/${a.id}/record`, { token: A.token }));
  assert.equal(Number((await level())?.quantity ?? 0), 0);
  // avec la case : brouillon sans mouvement, entrée à l'enregistrement
  const d = ok(await inv([L(prod, 10, '50')], { stockEntry: true }), 201); assert.equal(d.stockEntry, true);
  assert.equal(Number((await level())?.quantity ?? 0), 0, 'rien avant l\'enregistrement');
  const r = ok(await c('POST', `/purchase-invoices/${d.id}/record`, { token: A.token })); assert.equal(r.stockMovements, 1);
  const lv = await level(); assert.equal(Number(lv.quantity), 10); assert.equal(Number(lv.avgCost ?? lv.averageCost), 50);
  assert.equal((await c('POST', `/purchase-invoices/${d.id}/record`, { token: A.token })).status, 409, 'pas de double entrée');
  // annulation : mouvement inverse
  ok(await c('POST', `/purchase-invoices/${d.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } })); assert.equal(Number((await level()).quantity), 0);
});

test('garde-fous : commande/réception, aucun article suivi, stock déjà sorti, modification du brouillon', async () => {
  // aucun article suivi
  const p = ok(await inv([L(plain, 1, '10')], { stockEntry: true }), 201);
  assert.equal((await c('POST', `/purchase-invoices/${p.id}/record`, { token: A.token })).body.error.code, 'NOTHING_TO_STOCK');
  // option retirée sur le brouillon (PUT) -> plus d'entrée
  const u = ok(await c('PUT', `/purchase-invoices/${p.id}`, { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: p.supplierRef, stockEntry: false, lines: [L(plain, 1, '10')] } })); assert.equal(u.stockEntry, false);
  ok(await c('POST', `/purchase-invoices/${p.id}/record`, { token: A.token }));
  // facture issue d'une commande : option refusée
  const o = ok(await c('POST', '/purchase-orders', { token: A.token, body: { supplierId: sup.id, issueDate: today, lines: [L(prod, 3, '10')] } }), 201); ok(await c('POST', `/purchase-orders/${o.id}/confirm`, { token: A.token }));
  const fo = ok(await c('POST', `/purchase-invoices/from-order/${o.id}`, { token: A.token, body: { supplierRef: ref() } }), 201);
  assert.equal((await c('PUT', `/purchase-invoices/${fo.id}`, { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: fo.supplierRef, stockEntry: true, orderId: o.id, lines: [L(prod, 3, '10')] } })).body.error.code, 'STOCK_ENTRY_NOT_ALLOWED');
  // entrepôt inconnu
  assert.equal((await inv([L(prod, 1, '5')], { stockEntry: true, warehouseId: '00000000-0000-4000-8000-000000000000' })).status, 422);
  // stock déjà consommé : l'annulation de la facture est refusée
  const d = ok(await inv([L(prod, 4, '25')], { stockEntry: true }), 201); ok(await c('POST', `/purchase-invoices/${d.id}/record`, { token: A.token }));
  const wh = ok(await c('GET', '/stock/warehouses', { token: A.token }))[0];
  const w = ok(await c('POST', '/stock/withdrawals', { token: A.token, body: { warehouseId: wh.id, date: today, reason: 'Casse', lines: [{ productId: prod.id, quantity: 3 }] } }), 201);
  ok(await c('POST', `/stock/withdrawals/${w.id}/validate`, { token: A.token }));
  ok(await c('PATCH', '/companies/current/settings', { token: A.token, body: { stock: { allowNegative: false } } })); // réglage « stock négatif interdit »
  const cancel = await c('POST', `/purchase-invoices/${d.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } });
  assert.equal(cancel.body.error.code, 'STOCK_INSUFFICIENT', JSON.stringify(cancel.body)); assert.equal(Number((await level()).quantity), 1);
});
