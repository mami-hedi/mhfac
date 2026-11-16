import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, ro, stockMgr, client, sup, tax19, prod, svc;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const code = (r) => r.body?.error?.code;
const qty = async () => Number((ok(await c('GET', `/stock/levels?q=${encodeURIComponent(prod.name)}`, { token: A.token }))).find((x) => x.productId === prod.id)?.quantity ?? 0);
let n = 0;
const L = (p, q, price = '100') => ({ productId: p.id, description: p.name, quantity: q, unitPrice: price, taxRateId: tax19.id });
const saleInv = (lines, extra = {}) => c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, dueDate: today, lines, ...extra } });
const buyInv = (lines, extra = {}) => c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: `DL-${Date.now()}-${++n}`, lines, ...extra } });
const entry = async (q) => { const wh = ok(await c('GET', '/stock/warehouses', { token: A.token }))[0]; const e = ok(await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: today, lines: [{ productId: prod.id, quantity: q, unitCost: '10.000' }] } }), 201); ok(await c('POST', `/stock/entries/${e.id}/validate`, { token: A.token })); };

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Logistique A'); B = await registerCompany(app.call, 'Logistique B');
  ro = await addMember(app.call, A, 'read_only'); stockMgr = await addMember(app.call, A, 'stock_manager');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Logistique' } }), 201);
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Logistique' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
  prod = ok(await c('POST', '/products', { token: A.token, body: { name: 'Clavier logistique', salePrice: '100', taxRateId: tax19.id, trackStock: true } }), 201);
  svc = ok(await c('POST', '/products', { token: A.token, body: { name: 'Installation', salePrice: '50', type: 'service', taxRateId: tax19.id } }), 201);
});
after(() => app.close());

test('vente directe : la sortie de stock se fait à l\'émission, avec contrôle de disponibilité et annulation inverse', async () => {
  await entry(10);
  const sc = ok(await c('POST', '/invoices/stock-check', { token: A.token, body: { lines: [{ productId: prod.id, quantity: 12 }] } }));
  assert.equal(sc.hasShortage, true); assert.equal(sc.items[0].available, '10.0000'); assert.equal(sc.items[0].insufficient, true);
  const d = ok(await saleInv([L(prod, 4)], { stockExit: true }), 201); assert.equal(d.stockExit, true);
  assert.equal(await qty(), 10, 'rien avant l\'émission');
  const i = ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token })); assert.equal(i.stockMovements, 1); assert.equal(await qty(), 6);
  assert.equal(i.logistics.canGenerateDeliveryNote, true, 'BL possible (document seul)');
  ok(await c('POST', `/invoices/${d.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } })); assert.equal(await qty(), 10, 'mouvement inverse');
  // sans la case : aucune écriture de stock
  const e = ok(await saleInv([L(prod, 2)]), 201); ok(await c('POST', `/invoices/${e.id}/issue`, { token: A.token })); assert.equal(await qty(), 10);
});

test('vente directe : stock insuffisant bloque (si réglage), l\'émission est atomique ; droits ; lignes sans article suivi', async () => {
  ok(await c('PATCH', '/companies/current/settings', { token: A.token, body: { stock: { allowNegative: false } } }));
  const d = ok(await saleInv([L(prod, 50)], { stockExit: true }), 201);
  const r = await c('POST', `/invoices/${d.id}/issue`, { token: A.token }); assert.equal(r.status, 409); assert.equal(code(r), 'STOCK_INSUFFICIENT');
  assert.equal(ok(await c('GET', `/invoices/${d.id}`, { token: A.token })).status, 'draft', 'toujours brouillon, sans numéro');
  assert.equal(await qty(), 10);
  const s = ok(await saleInv([L(svc, 1)], { stockExit: true }), 201);
  assert.equal(code(await c('POST', `/invoices/${s.id}/issue`, { token: A.token })), 'NOTHING_TO_STOCK');
  ok(await c('PATCH', '/companies/current/settings', { token: A.token, body: { stock: { allowNegative: true } } }));
  assert.equal((await c('POST', '/invoices/stock-check', { token: ro.token, body: { lines: [{ productId: prod.id, quantity: 1 }] } })).status, 403);
  assert.deepEqual(ok(await c('POST', '/invoices/stock-check', { token: B.token, body: { lines: [{ productId: prod.id, quantity: 1 }] } })).items, [], 'produit d\'une autre entreprise : rien n\'est révélé');
});

test('BL depuis une facture de vente : pré-rempli, lié, un seul actif, sortie unique de stock', async () => {
  const d = ok(await saleInv([L(prod, 3), L(svc, 1)]), 201);
  const draft = await c('POST', `/invoices/${d.id}/delivery-note`, { token: A.token }); assert.equal(draft.status, 409, 'facture non émise');
  const i = ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token })); assert.equal(i.logistics.canGenerateDeliveryNote, true);
  assert.equal((await c('POST', `/invoices/${d.id}/delivery-note`, { token: ro.token })).status, 403);
  assert.equal((await c('POST', `/invoices/${d.id}/delivery-note`, { token: B.token })).status, 404);
  const g = ok(await c('POST', `/invoices/${d.id}/delivery-note`, { token: A.token, body: {} }), 201);
  const bl = ok(await c('GET', `/delivery-notes/${g.deliveryNoteId}`, { token: A.token }));
  assert.equal(bl.status, 'draft'); assert.equal(bl.sourceInvoice.id, d.id); assert.equal(bl.order, null); assert.equal(bl.stockImpact, true);
  assert.equal(bl.lines.length, 1, 'le service n\'est pas livrable'); assert.equal(Number(bl.lines[0].quantity), 3);
  assert.equal(code(await c('POST', `/invoices/${d.id}/delivery-note`, { token: A.token, body: {} })), 'DELIVERY_NOT_ALLOWED', 'un seul BL actif');
  assert.equal(code(await c('POST', `/invoices/${d.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } })), 'HAS_DELIVERY_NOTE');
  // brouillon : seules les infos d'en-tête se modifient
  ok(await c('PUT', `/delivery-notes/${bl.id}`, { token: A.token, body: { deliveryDate: today, notes: 'Retrait client' } }));
  assert.equal(await qty(), 10);
  const v = ok(await c('POST', `/delivery-notes/${bl.id}/validate`, { token: A.token })); assert.equal(v.status, 'validated'); assert.equal(await qty(), 7);
  assert.equal(code(await c('POST', `/delivery-notes/${bl.id}/invoice`, { token: A.token, body: {} })), 'SOURCE_IS_INVOICE');
  assert.equal(code(await c('POST', '/sales-returns', { token: A.token, body: { sourceId: bl.id, returnDate: today, reason: 'Retour test', lines: [{ sourceLineId: 1, quantity: 1 }] } })), 'RETURN_NOT_SUPPORTED');
  // annuler le BL : stock restitué, la facture peut en recevoir un nouveau
  ok(await c('POST', `/delivery-notes/${bl.id}/cancel`, { token: A.token, body: { reason: 'Livraison annulée' } })); assert.equal(await qty(), 10);
  ok(await c('POST', `/invoices/${d.id}/delivery-note`, { token: A.token, body: {} }), 201);
});

test('BL depuis une facture qui a déjà sorti le stock : document seul, aucun second mouvement', async () => {
  const d = ok(await saleInv([L(prod, 2)], { stockExit: true }), 201); ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token })); assert.equal(await qty(), 8);
  const g = ok(await c('POST', `/invoices/${d.id}/delivery-note`, { token: A.token, body: {} }), 201);
  const bl = ok(await c('GET', `/delivery-notes/${g.deliveryNoteId}`, { token: A.token })); assert.equal(bl.stockImpact, false);
  ok(await c('POST', `/delivery-notes/${bl.id}/validate`, { token: A.token })); assert.equal(await qty(), 8, 'une marchandise ne sort qu\'une fois');
  const lk = ok(await c('GET', `/invoices/${d.id}`, { token: A.token })); assert.equal(lk.deliveryNotes.length, 1);
});

test('achat : BR depuis une facture enregistrée, entrée unique au coût de la facture', async () => {
  const before_ = await qty();
  const d = ok(await buyInv([L(prod, 5, '40'), L(svc, 1, '10')]), 201);
  assert.equal(code(await c('POST', `/purchase-invoices/${d.id}/receipt`, { token: A.token, body: {} })), 'RECEIPT_NOT_ALLOWED', 'facture non enregistrée');
  const r = ok(await c('POST', `/purchase-invoices/${d.id}/record`, { token: A.token })); assert.equal(r.logistics.canGenerateReceipt, true); assert.equal(await qty(), before_);
  assert.equal((await c('POST', `/purchase-invoices/${d.id}/receipt`, { token: ro.token, body: {} })).status, 403);
  assert.equal((await c('POST', `/purchase-invoices/${d.id}/receipt`, { token: B.token, body: {} })).status, 404);
  const g = ok(await c('POST', `/purchase-invoices/${d.id}/receipt`, { token: A.token, body: {} }), 201);
  const br = ok(await c('GET', `/purchase-receipts/${g.receiptId}`, { token: A.token }));
  assert.equal(br.status, 'draft'); assert.equal(br.sourceInvoice.id, d.id); assert.equal(br.order, null); assert.equal(br.lines.length, 1); assert.equal(br.supplierRef, d.supplierRef);
  assert.equal(code(await c('POST', `/purchase-invoices/${d.id}/receipt`, { token: A.token, body: {} })), 'RECEIPT_NOT_ALLOWED', 'un seul BR actif');
  assert.equal(code(await c('POST', `/purchase-invoices/${d.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } })), 'HAS_RECEIPT');
  assert.equal(code(await c('POST', `/purchase-invoices/from-receipt/${br.id}`, { token: A.token, body: { supplierRef: 'X-1' } })) !== undefined, true);
  const v = ok(await c('POST', `/purchase-receipts/${br.id}/validate`, { token: A.token })); assert.equal(v.status, 'validated'); assert.equal(v.stockMovements, 1);
  assert.equal(await qty(), before_ + 5);
  const lv = ok(await c('GET', `/stock/levels?q=${encodeURIComponent(prod.name)}`, { token: A.token })).find((x) => x.productId === prod.id);
  assert.ok(Number(lv.avgCost ?? lv.averageCost) > 0);
  assert.equal((await c('POST', `/purchase-returns`, { token: A.token, body: { sourceId: br.id, returnDate: today, reason: 'Retour test', lines: [{ sourceLineId: 1, quantity: 1 }] } })).body.error.code, 'RETURN_NOT_SUPPORTED');
  ok(await c('POST', `/purchase-receipts/${br.id}/cancel`, { token: A.token, body: { reason: 'Réception annulée' } })); assert.equal(await qty(), before_);
});

test('achat : facture qui a déjà fait entrer le stock → pas de BR (ALREADY_IN_STOCK) ; stock-exit/entrée jamais cumulés', async () => {
  const d = ok(await buyInv([L(prod, 2, '30')], { stockEntry: true }), 201); const r = ok(await c('POST', `/purchase-invoices/${d.id}/record`, { token: A.token }));
  assert.equal(r.logistics.canGenerateReceipt, false);
  assert.equal(code(await c('POST', `/purchase-invoices/${d.id}/receipt`, { token: A.token, body: {} })), 'ALREADY_IN_STOCK');
  // utilisateur sans droit de réception (gestionnaire de stock peut, lecture seule non) : déjà vérifié ; lecture
  assert.equal((await c('GET', `/purchase-receipts`, { token: stockMgr.token })).status, 200);
});

test('aperçu PDF d\'un document fictif : droits, validation, aucune écriture', async () => {
  const [{ pool }] = [await import('../src/config/db.js')];
  const before_ = (await pool.query('SELECT COUNT(*) n FROM invoices'))[0][0].n;
  for (const kind of ['invoice', 'quote', 'delivery_note']) for (const pdfLanguage of ['fr']) {
    const res = await fetch(`${app.base}/sales/sample-pdf`, { method: 'POST', headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind, pdfLanguage, accentColor: '#0f766e' }) });
    assert.equal(res.status, 200); assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  }
  assert.equal((await c('POST', '/sales/sample-pdf', { token: A.token, body: { accentColor: 'rouge' } })).status, 400);
  assert.equal((await c('POST', '/sales/sample-pdf', { body: {} })).status, 401);
  assert.equal((await pool.query('SELECT COUNT(*) n FROM invoices'))[0][0].n, before_);
});
