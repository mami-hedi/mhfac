import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, stockMgr, readOnly, client, client2, sup, tax19, tax7, prod, wh;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const rep = (key, qs = '', token = A.token) => c('GET', `/reports/${key}${qs ? `?${qs}` : ''}`, { token });
const mkInvoice = async (cl, price, taxRateId = tax19.id, extra = {}) => { const d = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: cl.id, issueDate: today, lines: [{ description: 'Prestation', quantity: 1, unitPrice: price, taxRateId }], ...extra } }), 201).data; return ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token })).data; };

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Rapports A'); B = await registerCompany(app.call, 'Rapports B');
  stockMgr = await addMember(app.call, A, 'stock_manager'); readOnly = await addMember(app.call, A, 'read_only');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Rapport' } }), 201).data; client2 = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Second Client' } }), 201).data;
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Rapport' } }), 201).data;
  const rates = ok(await c('GET', '/tax-rates', { token: A.token })).data; tax19 = rates.find((t) => t.rate === '19.00'); tax7 = rates.find((t) => t.rate === '7.00');
  prod = ok(await c('POST', '/products', { token: A.token, body: { name: 'Article Rapport', salePrice: '100', taxRateId: tax19.id, trackStock: true } }), 201).data;
  wh = ok(await c('GET', '/stock/warehouses', { token: A.token })).data[0];
});
after(() => app.close());

test('rapports : catalogue filtré par permissions, période invalide, rapport inconnu, isolation', async () => {
  const cat = ok(await c('GET', '/reports', { token: A.token })).data; assert.equal(cat.length, 11);
  const stockCat = ok(await c('GET', '/reports', { token: stockMgr.token })).data.map((r) => r.key); assert.ok(stockCat.includes('stock_movements') && !stockCat.includes('sales') && !stockCat.includes('vat'));
  assert.equal((await rep('sales', '', stockMgr.token)).status, 403, 'gestionnaire de stock : pas de rapport de ventes');
  assert.equal((await c('GET', '/reports/sales')).status, 401);
  assert.equal((await rep('nope')).status, 404);
  assert.equal((await rep('sales', 'from=2026-05-01&to=2026-04-01')).body.error.code, 'INVALID_PERIOD');
  assert.equal((await rep('sales', 'from=pas-une-date')).status, 400);
  await mkInvoice(client, '1000');
  assert.equal(ok(await rep('sales', '', B.token)).data.rows.length, 0, 'isolation entre entreprises');
  assert.equal((await rep('sales', `clientId=${client.id}`, B.token)).data?.rows?.length ?? 0, 0);
});

test('rapports de ventes, TVA, CA par période, par client et par produit : chiffres exacts', async () => {
  await mkInvoice(client2, '500', tax7.id);
  const i3 = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ productId: prod.id, description: 'Article Rapport', quantity: 2, unitPrice: '100', taxRateId: tax19.id }] } }), 201).data; const inv3 = ok(await c('POST', `/invoices/${i3.id}/issue`, { token: A.token })).data;
  await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ description: 'Brouillon', quantity: 1, unitPrice: '9999', taxRateId: tax19.id }] } }); // brouillon : exclu
  const s = ok(await rep('sales')).data; // 1000 + 500 + 200 HT ; TVA 190 + 35 + 38
  assert.equal(s.rows.length, 3); assert.equal(s.totals.ht, '1700.000'); assert.equal(s.totals.tax, '263.000');
  assert.equal(ok(await rep('sales', `clientId=${client2.id}`)).data.rows.length, 1);
  // avoir partiel (10 % de la facture 3) : négatif dans les rapports
  const cn = ok(await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: inv3.id, reason: 'Remise', lines: [{ invoiceLineId: ok(await c('GET', `/invoices/${inv3.id}`, { token: A.token })).data.lines[0].id, quantity: '0.5' }] } }), 201).data; ok(await c('POST', `/credit-notes/${cn.id}/issue`, { token: A.token }));
  const s2 = ok(await rep('sales')).data; assert.equal(s2.rows.length, 4); assert.equal(s2.totals.ht, '1650.000'); assert.ok(s2.rows.some((r) => r.type === 'Avoir' && r.ht === '-50.000'));
  // achats + TVA
  const p = ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: 'F-R1', lines: [{ description: 'Achat', quantity: 1, unitPrice: '300', taxRateId: tax19.id }] } }), 201).data; ok(await c('POST', `/purchase-invoices/${p.id}/record`, { token: A.token }));
  const pr = ok(await rep('purchases')).data; assert.equal(pr.rows.length, 1); assert.equal(pr.totals.ht, '300.000'); assert.equal(pr.totals.tax, '57.000');
  const vat = ok(await rep('vat')).data; const r19 = vat.rows.find((r) => r.rate === '19 %'); const r7 = vat.rows.find((r) => r.rate === '7 %');
  assert.equal(r19.vatCollected, '218.500'); assert.equal(r19.baseSales, '1150.000'); assert.equal(r19.vatDeductible, '57.000'); assert.equal(r19.balance, '161.500'); assert.equal(r7.vatCollected, '35.000');
  assert.equal(vat.totals.balance, '196.500'); // (190 + 38 − 9,5 avoir + 35) − 57
  // CA par période / par client / par produit
  const rev = ok(await rep('revenue', 'groupBy=month')).data; assert.equal(rev.rows.length, 1); assert.equal(rev.rows[0].period, today.slice(0, 7)); assert.equal(rev.rows[0].ht, '1650.000'); assert.equal(rev.rows[0].invoices, 3);
  const bc = ok(await rep('by_client')).data; assert.equal(bc.rows[0].party, 'Client Rapport'); assert.equal(bc.rows[0].ht, '1150.000'); assert.equal(bc.rows[0].share, '69.7 %'); assert.equal(bc.totals.ht, '1650.000');
  const bp = ok(await rep('by_product')).data; const art = bp.rows.find((r) => r.product === 'Article Rapport'); assert.equal(Number(art.quantity), 1.5); assert.equal(art.ht, '150.000');
  // encaissements, impayés, créances
  const inv1 = ok(await rep('unpaid')).data; assert.equal(inv1.rows.length, 3);
  const all = ok(await c('GET', '/invoices?limit=50', { token: A.token })).data; const first = all.find((i) => i.status === 'issued' && i.totalHt === '1000.000');
  ok(await c('POST', '/payments', { token: A.token, body: { clientId: client.id, date: today, method: 'cash', allocations: [{ invoiceId: first.id, amount: '400' }] } }), 201);
  const col = ok(await rep('collections')).data; assert.equal(col.rows.length, 1); assert.equal(col.totals.amount, '400.000'); assert.equal(col.rows[0].method, 'Espèces');
  const un = ok(await rep('unpaid')).data; assert.equal(un.rows.find((r) => r.number === first.number).balance, '790.000');
  assert.equal(ok(await rep('unpaid', 'overdueOnly=1')).data.rows.length, 0, 'rien en retard aujourd\'hui');
  const rec = ok(await rep('receivables')).data; assert.equal(rec.rows.length, 2); assert.equal(rec.rows.reduce((s, r) => s + Number(r.notDue), 0), Number(rec.totals.total)); // facture 3 : 238 - avoir 59.5 ; toutes non échues ou échues selon délai
  const pay = ok(await rep('payables')).data; assert.equal(pay.rows.length, 1); assert.equal(pay.totals.total, '357.000');
  // stock
  const v = ok(await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: today, lines: [{ productId: prod.id, quantity: 10, unitCost: '40' }] } }), 201).data; ok(await c('POST', `/stock/entries/${v.id}/validate`, { token: A.token }));
  const sm = ok(await rep('stock_movements', `productId=${prod.id}`, stockMgr.token)).data; assert.equal(sm.rows.length, 1); assert.equal(sm.rows[0].kind, 'Entrée'); assert.equal(sm.totals.totalCost, '400.000');
});

test('exports CSV / Excel / PDF : type MIME, contenu, injection de formule neutralisée', async () => {
  const evil = ok(await c('POST', '/clients', { token: A.token, body: { name: '=HYPERLINK("http://x")' } }), 201).data; await mkInvoice(evil, '10');
  const raw = async (format, key = 'sales', token = A.token) => { const res = await fetch(`${app.base}/reports/${key}?format=${format}`, { headers: { Authorization: `Bearer ${token}` } }); return { status: res.status, type: res.headers.get('content-type'), disp: res.headers.get('content-disposition'), buf: Buffer.from(await res.arrayBuffer()) }; };
  const csv = await raw('csv'); assert.equal(csv.status, 200); assert.match(csv.type, /text\/csv/); assert.match(csv.disp, /attachment; filename="sales_/);
  const text = csv.buf.toString('utf8'); assert.ok(text.startsWith('\uFEFFDate;N°;Type;Client')); assert.ok(text.includes("'=HYPERLINK"), 'formule neutralisée'); assert.ok(!text.includes(';=HYPERLINK'));
  assert.match(text, /1000,000/); assert.match(text, /TOTAL/);
  const xlsx = await raw('xlsx'); assert.equal(xlsx.status, 200); assert.match(xlsx.type, /spreadsheetml/); assert.equal(xlsx.buf.subarray(0, 2).toString(), 'PK');
  const pdf = await raw('pdf'); assert.equal(pdf.status, 200); assert.equal(pdf.type, 'application/pdf'); assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');
  const pdf2 = await raw('pdf', 'vat'); assert.equal(pdf2.buf.subarray(0, 4).toString(), '%PDF');
  assert.equal((await raw('csv', 'sales', stockMgr.token)).status, 403, 'export soumis aux mêmes droits');
  assert.equal((await raw('csv', 'sales', readOnly.token)).status, 200, 'lecture seule peut exporter ce qu\'il peut lire');
  assert.equal((await raw('docx')).status, 400);
});
