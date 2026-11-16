import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';
import { pool } from '../src/config/db.js';

let app, A, B, readOnly, sup, tax19, prod, plain, wh;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const level = async () => (ok(await c('GET', `/stock/levels?q=${encodeURIComponent(prod.name)}`, { token: A.token }))).find((x) => x.productId === prod.id);
const line = (p, q, price, extra = {}) => ({ productId: p.id, description: p.name, quantity: q, unitPrice: price, taxRateId: tax19.id, ...extra });
const mkOrder = async (lines, extra = {}) => {
  const o = ok(await c('POST', '/purchase-orders', { token: A.token, body: { supplierId: sup.id, issueDate: today, lines, ...extra } }), 201);
  return ok(await c('POST', `/purchase-orders/${o.id}/confirm`, { token: A.token }));
};
const mkReceipt = async (order, lines, extra = {}) => {
  const r = await c('POST', '/purchase-receipts', { token: A.token, body: { orderId: order.id, receiptDate: today, lines: lines.map(([i, q]) => ({ orderLineId: order.lines[i].id, quantity: q })), ...extra } });
  return ok(r, 201);
};
let refN = 0; const nextRef = () => `FOURN-${Date.now()}-${++refN}`;

before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Achats A'); B = await registerCompany(app.call, 'Achats B');
  readOnly = await addMember(app.call, A, 'read_only');
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Tunis' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
  prod = ok(await c('POST', '/products', { token: A.token, body: { name: 'Clavier pro', salePrice: '100', taxRateId: tax19.id, trackStock: true } }), 201);
  plain = ok(await c('POST', '/products', { token: A.token, body: { name: 'Service transport', salePrice: '10', taxRateId: tax19.id } }), 201);
  wh = ok(await c('GET', '/stock/warehouses', { token: A.token }))[0];
});
after(() => app.close());

test('commande fournisseur : totaux serveur, numéro à la confirmation, verrouillage', async () => {
  const o = ok(await c('POST', '/purchase-orders', { token: A.token, body: { supplierId: sup.id, issueDate: today, lines: [line(prod, 10, '50')] } }), 201);
  assert.equal(o.status, 'draft'); assert.equal(o.totalHt, '500.000'); assert.equal(o.totalTtc, '595.000');
  assert.equal(o.supplierId, sup.id);
  const cf = ok(await c('POST', `/purchase-orders/${o.id}/confirm`, { token: A.token }));
  assert.match(cf.number, /^BCF-\d{4}-\d{5}$/); assert.equal(cf.status, 'confirmed');
  assert.equal((await c('PUT', `/purchase-orders/${o.id}`, { token: A.token, body: { supplierId: sup.id, issueDate: today, lines: [line(prod, 1, '1')] } })).status, 409);
  assert.equal((await c('DELETE', `/purchase-orders/${o.id}`, { token: A.token })).status, 409);
  assert.equal((await c('GET', `/purchase-orders/${o.id}`, { token: B.token })).status, 404, 'isolation multi-société');
  assert.equal((await c('POST', '/purchase-orders', { token: readOnly.token, body: { supplierId: sup.id, issueDate: today, lines: [line(prod, 1, '1')] } })).status, 403);
  assert.equal((await c('POST', '/purchase-orders', { token: A.token, body: { supplierId: sup.id, issueDate: today, lines: [] } })).status, 400);
});

test('réception partielle : plafonds, entrée en stock au coût de la commande, CMUP, idempotence', async () => {
  const o = await mkOrder([line(prod, 10, '100', { discountPct: '10' })]); // coût net 90
  const r1 = await mkReceipt(o, [[0, 4]]);
  assert.equal(r1.status, 'draft');
  assert.equal((await level())?.quantity ?? '0.0000', '0.0000', 'brouillon sans effet sur le stock');
  const v = ok(await c('POST', `/purchase-receipts/${r1.id}/validate`, { token: A.token }));
  assert.match(v.number, /^BR-\d{4}-\d{5}$/);
  let l = await level(); assert.equal(l.quantity, '4.0000'); assert.equal(l.avgCost, '90.0000');
  assert.equal((await c('POST', `/purchase-receipts/${r1.id}/validate`, { token: A.token })).status, 409);
  const [mv] = await pool.query("SELECT * FROM stock_movements WHERE source_type = 'purchase_receipt'"); assert.equal(mv.length >= 1, true);
  // plafond : 7 > 6 restant
  const over = await c('POST', '/purchase-receipts', { token: A.token, body: { orderId: o.id, receiptDate: today, lines: [{ orderLineId: o.lines[0].id, quantity: 7 }] } });
  assert.equal(over.status, 422, over.raw);
  const r2 = await mkReceipt(o, [[0, 6]]); ok(await c('POST', `/purchase-receipts/${r2.id}/validate`, { token: A.token }));
  l = await level(); assert.equal(l.quantity, '10.0000');
  const full = ok(await c('GET', `/purchase-orders/${o.id}`, { token: A.token })); assert.equal(full.receiptStatus, 'complete');
  assert.equal((await c('POST', '/purchase-receipts', { token: readOnly.token, body: { orderId: o.id, receiptDate: today, lines: [] } })).status, 403);
});

test('annulation d\'une réception : stock inversé, bloquée si facturée', async () => {
  const before0 = Number((await level()).quantity);
  const o = await mkOrder([line(prod, 5, '80')]);
  const r = await mkReceipt(o, [[0, 5]]); ok(await c('POST', `/purchase-receipts/${r.id}/validate`, { token: A.token }));
  assert.equal(Number((await level()).quantity), before0 + 5);
  const inv = ok(await c('POST', `/purchase-invoices/from-receipt/${r.id}`, { token: A.token, body: { supplierRef: nextRef() } }), 201);
  assert.equal((await c('POST', `/purchase-receipts/${r.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } })).status, 409, 'facturée');
  assert.equal((await c('DELETE', `/purchase-invoices/${inv.id}`, { token: A.token })).status, 204);
  const cx = ok(await c('POST', `/purchase-receipts/${r.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } }));
  assert.equal(cx.status, 'cancelled'); assert.equal(Number((await level()).quantity), before0, 'stock rétabli');
  assert.equal((await c('POST', `/purchase-receipts/${r.id}/cancel`, { token: A.token, body: { reason: 'Encore' } })).status, 409);
});

test('facture d\'achat : depuis commande, n° fournisseur unique, enregistrement figé, annulation', async () => {
  const o = await mkOrder([line(prod, 2, '50'), line(plain, 1, '30')]);
  const ref1 = nextRef();
  const inv = ok(await c('POST', `/purchase-invoices/from-order/${o.id}`, { token: A.token, body: { supplierRef: ref1 } }), 201);
  assert.equal(inv.status, 'draft'); assert.equal(inv.totalHt, '130.000'); assert.equal(inv.totalTtc, '154.700');
  assert.equal((await c('POST', `/purchase-invoices/from-order/${o.id}`, { token: A.token, body: { supplierRef: nextRef() } })).status, 409, 'déjà facturée');
  const rec = ok(await c('POST', `/purchase-invoices/${inv.id}/record`, { token: A.token }));
  assert.match(rec.number, /^FA-\d{4}-\d{5}$/); assert.equal(rec.status, 'recorded'); assert.equal(rec.balance, '154.700');
  assert.equal((await c('PUT', `/purchase-invoices/${inv.id}`, { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: ref1, lines: [line(prod, 1, '1')] } })).status, 409);
  assert.equal((await c('DELETE', `/purchase-invoices/${inv.id}`, { token: A.token })).status, 409);
  // doublon du n° fournisseur
  const dup = await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: ref1, lines: [line(plain, 1, '10')] } });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'DUPLICATE_SUPPLIER_REF');
  const o2 = ok(await c('GET', `/purchase-orders/${o.id}`, { token: A.token })); assert.equal(o2.invoicingStatus, 'invoiced');
  const can = ok(await c('POST', `/purchase-invoices/${inv.id}/cancel`, { token: A.token, body: { reason: 'Facture erronée' } }));
  assert.equal(can.status, 'cancelled');
  // le n° fournisseur redevient utilisable après annulation
  ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: ref1, lines: [line(plain, 1, '10')] } }), 201);
});

test('avoir fournisseur : plafond cumulé, enregistrement, solde et règlements', async () => {
  const inv0 = ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: nextRef(), lines: [line(plain, 10, '100')] } }), 201);
  const inv = ok(await c('POST', `/purchase-invoices/${inv0.id}/record`, { token: A.token }));
  assert.equal(inv.totalTtc, '1190.000');
  const lineId = inv.lines[0].id;
  const tooMuch = await c('POST', '/purchase-credit-notes', { token: A.token, body: { invoiceId: inv.id, supplierRef: nextRef(), reason: 'Retour', lines: [{ invoiceLineId: lineId, quantity: 11 }] } });
  assert.equal(tooMuch.status, 422); assert.equal(tooMuch.body.error.code, 'CREDIT_EXCEEDS_INVOICE');
  const cn = ok(await c('POST', '/purchase-credit-notes', { token: A.token, body: { invoiceId: inv.id, supplierRef: nextRef(), reason: 'Marchandise défectueuse', lines: [{ invoiceLineId: lineId, quantity: 4 }] } }), 201);
  assert.equal(cn.totalTtc, '476.000');
  const cnr = ok(await c('POST', `/purchase-credit-notes/${cn.id}/record`, { token: A.token })); assert.match(cnr.number, /^AVF-\d{4}-\d{5}$/);
  let f = ok(await c('GET', `/purchase-invoices/${inv.id}`, { token: A.token })); assert.equal(f.balance, '714.000'); assert.equal(f.lines[0].creditableQuantity, '6.0000');
  assert.equal((await c('POST', `/purchase-invoices/${inv.id}/cancel`, { token: A.token, body: { reason: 'Tentative' } })).status, 409, 'avoir existant');
  const more = await c('POST', '/purchase-credit-notes', { token: A.token, body: { invoiceId: inv.id, supplierRef: nextRef(), reason: 'Trop', lines: [{ invoiceLineId: lineId, quantity: 7 }] } });
  assert.equal(more.status, 422);
  // règlements
  const pay = async (amount, token = A.token) => c('POST', '/supplier-payments', { token, body: { supplierId: sup.id, date: today, method: 'bank_transfer', allocations: [{ invoiceId: inv.id, amount }] } });
  assert.equal((await pay('714.001')).status, 422, 'sur-paiement refusé');
  const p1 = ok(await pay('300'), 201); assert.match(p1.number, /^RGF-\d{4}-\d{5}$/);
  f = ok(await c('GET', `/purchase-invoices/${inv.id}`, { token: A.token })); assert.equal(f.paymentStatus, 'partial'); assert.equal(f.balance, '414.000');
  assert.equal((await pay('100', readOnly.token)).status, 403);
  assert.equal((await c('GET', `/supplier-payments/${p1.id}`, { token: B.token })).status, 404);
  const p2 = ok(await pay('414'), 201);
  f = ok(await c('GET', `/purchase-invoices/${inv.id}`, { token: A.token })); assert.equal(f.paymentStatus, 'paid'); assert.equal(f.balance, '0.000');
  ok(await c('POST', `/supplier-payments/${p2.id}/cancel`, { token: A.token, body: { reason: 'Virement rejeté' } }));
  f = ok(await c('GET', `/purchase-invoices/${inv.id}`, { token: A.token })); assert.equal(f.balance, '414.000');
  assert.equal((await c('POST', `/purchase-invoices/${inv.id}/cancel`, { token: A.token, body: { reason: 'Avec règlements' } })).status, 409);
  const list = ok(await c('GET', '/purchase-invoices?open=1', { token: A.token })); assert.ok(list.some((x) => x.id === inv.id));
});

test('facture par réception : une réception = une facture ; facture libre sans effet sur le stock', async () => {
  const o = await mkOrder([line(prod, 3, '60')]);
  const r = await mkReceipt(o, [[0, 3]]); ok(await c('POST', `/purchase-receipts/${r.id}/validate`, { token: A.token }));
  const q0 = (await level()).quantity;
  const inv = ok(await c('POST', `/purchase-invoices/from-receipt/${r.id}`, { token: A.token, body: { supplierRef: nextRef() } }), 201);
  assert.equal(inv.totalHt, '180.000');
  assert.equal((await c('POST', `/purchase-invoices/from-receipt/${r.id}`, { token: A.token, body: { supplierRef: nextRef() } })).status, 409);
  ok(await c('POST', `/purchase-invoices/${inv.id}/record`, { token: A.token }));
  assert.equal((await level()).quantity, q0, 'la facture ne bouge pas le stock');
  ok(await c('POST', `/purchase-invoices/${inv.id}/cancel`, { token: A.token, body: { reason: 'Refacturation' } }));
  ok(await c('POST', `/purchase-invoices/from-receipt/${r.id}`, { token: A.token, body: { supplierRef: nextRef() } }), 201);
});

test('PDF de la commande fournisseur', async () => {
  const o = await mkOrder([line(prod, 1, '10')]);
  const res = await fetch(`${app.base}/purchase-orders/${o.id}/pdf`, { headers: { authorization: `Bearer ${A.token}` } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /pdf/);
  const buf = Buffer.from(await res.arrayBuffer()); assert.equal(buf.subarray(0, 4).toString(), '%PDF');
});
