import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany } from './helpers.js';

let app, A, client, supplier, tax;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const line = () => ({ description: 'Prestation', quantity: 1, unitPrice: '100', taxRateId: tax.id }); // TTC 119,000
let n = 0;
const sale = (extra = {}) => c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [line()], ...extra } });
const buy = (extra = {}) => c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: supplier.id, issueDate: today, supplierRef: `T-${Date.now()}-${n++}`, lines: [line()], ...extra } });
const ok = (r, s = 201) => { assert.equal(r.status, s, r.raw); return r.body.data; };

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Timbre');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client timbre' } }));
  supplier = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur timbre' } }));
  tax = ok(await c('GET', '/tax-rates', { token: A.token }), 200).find((t) => t.rate === '19.00');
});
after(() => app.close());

test('ventes : le timbre n\'est jamais imposé (ni par défaut, ni quand il est pré-coché)', async () => {
  assert.equal(ok(await sale()).stampDuty, '0.000', 'désactivé par défaut');
  ok(await c('PATCH', '/companies/current/settings', { token: A.token, body: { sales: { stampDutyEnabled: true, stampDutyAmount: '1.000' } } }), 200);
  const dflt = ok(await sale()); assert.equal(dflt.stampDuty, '1.000', 'pré-coché par défaut'); assert.equal(dflt.netPayable, '120.000');
  const off = ok(await sale({ applyStampDuty: false })); assert.equal(off.stampDuty, '0.000'); assert.equal(off.netPayable, '119.000');
  const sneaky = ok(await sale({ applyStampDuty: true, stampDutyAmount: '50' })); assert.equal(sneaky.stampDuty, '1.000', 'le montant d\'une vente vient des paramètres, jamais du client');
  const issued = ok(await c('POST', `/invoices/${off.id}/issue`, { token: A.token }), 200); assert.equal(issued.stampDuty, '0.000'); assert.equal(issued.netPayable, '119.000');
});

test('achats : timbre facultatif, montant propre à chaque facture, validé, conservé à l\'enregistrement', async () => {
  assert.equal(ok(await buy()).stampDuty, '0.000', 'aucun timbre par défaut');
  assert.equal(ok(await buy({ applyStampDuty: false })).stampDuty, '0.000');
  assert.equal(ok(await buy({ stampDutyAmount: '2' })).stampDuty, '0.000', 'un montant sans case cochée est ignoré');
  const d = ok(await buy({ applyStampDuty: true, stampDutyAmount: '1,500' }));
  assert.equal(d.stampDuty, '1.500'); assert.equal(d.totalTtc, '119.000'); assert.equal(d.netPayable, '120.500');
  assert.equal(ok(await buy({ applyStampDuty: true })).stampDuty, '1.000', 'case cochée sans montant : montant des paramètres');
  for (const bad of ['abc', '-1', '1.2345', '99999']) assert.equal((await buy({ applyStampDuty: true, stampDutyAmount: bad })).status, 400, bad);
  const rec = ok(await c('POST', `/purchase-invoices/${d.id}/record`, { token: A.token }), 200);
  assert.equal(rec.status, 'recorded'); assert.equal(rec.stampDuty, '1.500'); assert.equal(rec.netPayable, '120.500');
});

test('achats : modifier un brouillon pour retirer le timbre', async () => {
  const d = ok(await buy({ applyStampDuty: true, stampDutyAmount: '1' }));
  assert.equal(d.stampDuty, '1.000');
  const body = { supplierId: supplier.id, issueDate: today, supplierRef: d.supplierRef, lines: [line()], applyStampDuty: false };
  const u = ok(await c('PUT', `/purchase-invoices/${d.id}`, { token: A.token, body }), 200);
  assert.equal(u.stampDuty, '0.000'); assert.equal(u.netPayable, '119.000');
  assert.equal(ok(await c('POST', `/purchase-invoices/${d.id}/record`, { token: A.token }), 200).netPayable, '119.000');
});
