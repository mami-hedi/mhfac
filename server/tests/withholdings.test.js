import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, readOnly, sales, client, sup, tax19;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'RS A'); B = await registerCompany(app.call, 'RS B');
  readOnly = await addMember(app.call, A, 'read_only'); sales = await addMember(app.call, A, 'sales');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client RS' } }), 201); sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur RS' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
});
after(() => app.close());

test('retenue à la source : listes ventes/achats dérivées des factures, suivi des attestations', async () => {
  const line = [{ description: 'Prestation', quantity: 1, unitPrice: '1000', taxRateId: tax19.id }];
  const d = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, withholdingPct: '1.5', lines: line } }), 201);
  assert.equal((await c('GET', '/withholdings/sales', { token: A.token })).body.data.length, 0, 'brouillon exclu');
  const inv = ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token }));
  assert.equal(inv.withholdingAmount, '17.850'); // 1190 x 1,5 %
  const noRs = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, withholdingPct: '0', lines: line } }), 201); ok(await c('POST', `/invoices/${noRs.id}/issue`, { token: A.token }));
  const r = await c('GET', '/withholdings/sales', { token: A.token });
  assert.equal(r.body.data.length, 1, 'seules les factures avec retenue'); assert.equal(r.body.data[0].amount, '17.850'); assert.equal(r.body.data[0].certificate.status, 'pending'); assert.equal(r.body.meta.totalTnd, '17.850'); assert.equal(r.body.meta.certifiedTnd, '0.000');
  assert.equal(ok(await c('GET', '/withholdings/sales', { token: B.token })).length, 0, 'isolation');
  const put = (token, body, id = inv.id) => c('PUT', `/withholdings/sales/${id}/certificate`, { token, body });
  assert.equal((await put(readOnly.token, { status: 'done', certificateNumber: 'A1', certificateDate: today })).status, 403);
  assert.equal((await put(sales.token, { status: 'done', certificateNumber: 'A1', certificateDate: today })).status, 403, 'rôle sales : lecture seule sur RS');
  assert.equal((await put(A.token, { status: 'done' })).body.error.code, 'CERTIFICATE_INCOMPLETE');
  assert.equal((await put(B.token, { status: 'pending' })).status, 404, 'autre entreprise');
  assert.equal((await put(A.token, { status: 'pending' }, noRs.id)).status, 404, 'facture sans retenue');
  ok(await put(A.token, { status: 'done', certificateNumber: 'ATT-2026-17', certificateDate: today }));
  const after1 = await c('GET', '/withholdings/sales?status=done', { token: A.token }); assert.equal(after1.body.data.length, 1); assert.equal(after1.body.meta.certifiedTnd, '17.850'); assert.equal(after1.body.data[0].certificate.number, 'ATT-2026-17');
  assert.equal((await c('GET', '/withholdings/sales?status=pending', { token: A.token })).body.data.length, 0);
  assert.equal(ok(await c('GET', `/invoices/${inv.id}`, { token: A.token })).withholdingAmount, '17.850', 'la facture n\'est pas modifiée');
  // achats
  const p = ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: 'F-RS-1', withholdingPct: '1.5', lines: line } }), 201);
  assert.equal(ok(await c('GET', '/withholdings/purchases', { token: A.token })).length, 0, 'brouillon exclu');
  ok(await c('POST', `/purchase-invoices/${p.id}/record`, { token: A.token }));
  const pr = await c('GET', '/withholdings/purchases?q=F-RS-1', { token: A.token }); assert.equal(pr.body.data.length, 1); assert.equal(pr.body.data[0].amount, '17.850'); assert.equal(pr.body.data[0].supplierRef, 'F-RS-1');
  ok(await c('PUT', `/withholdings/purchases/${p.id}/certificate`, { token: A.token, body: { status: 'done', certificateNumber: 'D-1', certificateDate: today } }));
  assert.equal(ok(await c('GET', '/withholdings/purchases?status=done', { token: A.token })).length, 1);
});
