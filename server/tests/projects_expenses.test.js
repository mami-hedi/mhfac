import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, readOnly, accountant, client, client2, sup, tax19;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Projets A'); B = await registerCompany(app.call, 'Projets B');
  readOnly = await addMember(app.call, A, 'read_only'); accountant = await addMember(app.call, A, 'accountant');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Projet' } }), 201); client2 = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Autre Client' } }), 201);
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Projet' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
});
after(() => app.close());
const lines = (p = '1000') => [{ description: 'Prestation', quantity: 1, unitPrice: p, taxRateId: tax19.id }];

test('notes de débours : brouillon, validation, numérotation, annulation, droits, isolation', async () => {
  const body = { clientId: client.id, noteDate: today, lines: [{ description: 'Droits d\'enregistrement', payee: 'Recette des finances', proofRef: 'Q-123', amount: '120,500' }, { description: 'Timbres', amount: '10' }] };
  assert.equal((await c('POST', '/sales-expense-notes', { token: readOnly.token, body })).status, 403);
  assert.equal((await c('POST', '/sales-expense-notes', { token: A.token, body: { ...body, noteDate: '2999-01-01' } })).body.error.code, 'FUTURE_DATE');
  assert.equal((await c('POST', '/sales-expense-notes', { token: A.token, body: { ...body, lines: [{ description: 'Zéro', amount: '0' }] } })).status, 400);
  const d = ok(await c('POST', '/sales-expense-notes', { token: A.token, body }), 201);
  assert.equal(d.status, 'draft'); assert.equal(d.total, '130.500'); assert.equal(d.number, null);
  const upd = ok(await c('PUT', `/sales-expense-notes/${d.id}`, { token: A.token, body: { ...body, lines: [...body.lines, { description: 'Greffe', amount: '9.5' }] } })); assert.equal(upd.total, '140.000');
  assert.equal((await c('GET', `/sales-expense-notes/${d.id}`, { token: B.token })).status, 404, 'isolation');
  assert.equal((await c('GET', `/purchase-expense-notes/${d.id}`, { token: A.token })).status, 404, 'pas de croisement ventes/achats');
  assert.equal((await c('POST', `/sales-expense-notes/${d.id}/validate`, { token: readOnly.token })).status, 403);
  const v = ok(await c('POST', `/sales-expense-notes/${d.id}/validate`, { token: A.token })); assert.match(v.number, /^DEB-\d{4}-00001$/); assert.equal(v.status, 'validated');
  assert.equal((await c('PUT', `/sales-expense-notes/${d.id}`, { token: A.token, body })).body.error.code, 'NOT_DRAFT');
  assert.equal((await c('DELETE', `/sales-expense-notes/${d.id}`, { token: A.token })).status, 409);
  assert.equal((await c('POST', `/sales-expense-notes/${d.id}/cancel`, { token: A.token, body: { reason: 'xx' } })).status, 400);
  assert.equal(ok(await c('POST', `/sales-expense-notes/${d.id}/cancel`, { token: accountant.token, body: { reason: 'Débours refusé par le client' } })).status, 'cancelled');
  const d2 = ok(await c('POST', '/sales-expense-notes', { token: A.token, body }), 201); assert.equal((await c('DELETE', `/sales-expense-notes/${d2.id}`, { token: A.token })).status, 204);
  const pb = ok(await c('POST', '/purchase-expense-notes', { token: A.token, body: { supplierId: sup.id, noteDate: today, lines: [{ description: 'Frais douane', amount: '50' }] } }), 201);
  assert.match(ok(await c('POST', `/purchase-expense-notes/${pb.id}/validate`, { token: A.token })).number, /^DBA-/);
  assert.equal(ok(await c('GET', '/sales-expense-notes?status=cancelled', { token: A.token })).length, 1);
});

test('projets : création, rattachement de documents, synthèse, garde-fous', async () => {
  assert.equal((await c('POST', '/projects', { token: readOnly.token, body: { name: 'Interdit' } })).status, 403);
  assert.equal((await c('POST', '/projects', { token: A.token, body: { name: 'X', startDate: '2026-05-01', endDate: '2026-04-01' } })).status, 400);
  const p = ok(await c('POST', '/projects', { token: A.token, body: { name: 'Site web Client', clientId: client.id, budget: '2000', startDate: today } }), 201);
  assert.match(p.code, /^PRJ-\d{4}-001$/);
  assert.equal((await c('POST', '/projects', { token: A.token, body: { name: 'Doublon', code: p.code } })).body.error.code, 'DUPLICATE_CODE');
  // documents
  const inv = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: lines('1000') } }), 201);
  const link = (docType, docId, token = A.token) => c('POST', `/projects/${p.id}/documents`, { token, body: { docType, docId } });
  ok(await link('invoice', inv.id)); assert.equal(ok(await c('GET', `/projects/${p.id}`, { token: A.token })).summary.invoiced, '0.000', 'brouillon ne compte pas');
  ok(await c('POST', `/invoices/${inv.id}/issue`, { token: A.token }));
  assert.equal((await link('invoice', inv.id)).body.error.code, 'ALREADY_LINKED');
  const other = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client2.id, issueDate: today, lines: lines() } }), 201);
  assert.equal((await link('invoice', other.id)).body.error.code, 'CLIENT_MISMATCH');
  assert.equal((await link('invoice', inv.id, B.token)).status, 404, 'isolation');
  assert.equal((await link('credit_note', inv.id)).status, 404, 'mauvais type');
  const pi = ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: 'F-P1', lines: lines('400') } }), 201); ok(await c('POST', `/purchase-invoices/${pi.id}/record`, { token: A.token }));
  ok(await link('purchase_invoice', pi.id));
  const en = ok(await c('POST', '/purchase-expense-notes', { token: A.token, body: { supplierId: sup.id, noteDate: today, projectId: p.id, lines: [{ description: 'Frais', amount: '100' }] } }), 201); ok(await c('POST', `/purchase-expense-notes/${en.id}/validate`, { token: A.token }));
  const full = ok(await c('GET', `/projects/${p.id}`, { token: A.token }));
  assert.equal(full.summary.invoiced, '1000.000'); assert.equal(full.summary.purchased, '400.000'); assert.equal(full.summary.expensePurchase, '100.000');
  assert.equal(full.summary.margin, '600.000'); assert.equal(full.summary.result, '500.000'); assert.equal(full.summary.budgetRemaining, '1500.000'); assert.equal(full.summary.budgetUsedPct, 25);
  assert.equal(full.documents.length, 3, 'facture, facture d\'achat, note de débours');
  // avoir
  const cn = ok(await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: inv.id, reason: 'Remise commerciale', lines: [{ invoiceLineId: ok(await c('GET', `/invoices/${inv.id}`, { token: A.token })).lines[0].id, quantity: '0.1' }] } }), 201); ok(await c('POST', `/credit-notes/${cn.id}/issue`, { token: A.token }));
  ok(await link('credit_note', cn.id)); assert.equal(ok(await c('GET', `/projects/${p.id}`, { token: A.token })).summary.invoiced, '900.000');
  const linkable = ok(await c('GET', `/projects/${p.id}/linkable?docType=invoice`, { token: A.token })); assert.ok(linkable.every((x) => x.id !== inv.id));
  assert.equal((await c('DELETE', `/projects/${p.id}`, { token: A.token })).body.error.code, 'HAS_DOCUMENTS');
  assert.equal((await c('DELETE', `/projects/${p.id}/documents/invoice/${inv.id}`, { token: readOnly.token })).status, 403);
  assert.equal((await c('DELETE', `/projects/${p.id}/documents/invoice/${inv.id}`, { token: A.token })).status, 204);
  assert.equal(ok(await c('GET', `/invoices/${inv.id}`, { token: A.token })).status, 'issued', 'le détachement ne touche pas la facture');
  ok(await c('PUT', `/projects/${p.id}`, { token: A.token, body: { name: 'Site web Client', clientId: client.id, status: 'completed' } }));
  assert.equal((await link('invoice', inv.id)).body.error.code, 'PROJECT_CLOSED');
  const empty = ok(await c('POST', '/projects', { token: A.token, body: { name: 'Vide' } }), 201); assert.equal((await c('DELETE', `/projects/${empty.id}`, { token: A.token })).status, 204);
  assert.equal(ok(await c('GET', '/projects', { token: B.token })).length, 0);
});
