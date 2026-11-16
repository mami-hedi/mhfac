// Retenue à la source ajoutée APRÈS l'émission : la facture n'est pas modifiée, la retenue est un règlement spécial.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, reader, client, sup, tax19;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const month = today.slice(0, 7);
const issued = async (price = '100.000', extra = {}) => {
  const d = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, ...extra, lines: [{ description: 'Prestation', quantity: 1, unitPrice: price, taxRateId: tax19.id }] } }), 201);
  return ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token }));
};
const inv = async (id) => ok(await c('GET', `/invoices/${id}`, { token: A.token }));
const rs = (invoiceId, body = {}, token = A.token) => c('POST', '/payments/withholding', { token, body: { invoiceId, rate: '1.5', date: today, ...body } });

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'RS ajoutée A'); B = await registerCompany(app.call, 'RS ajoutée B'); reader = await addMember(app.call, A, 'read_only');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client RS', taxId: '1234567A' } }), 201);
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur RS', taxId: '1234567A', type: 'company', country: 'TN' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
});
after(() => app.close());

test('vente : aperçu, enregistrement, solde réduit, facture intacte, liste des retenues, annulation puis nouvelle saisie', async () => {
  const i = await issued('1000.000'); // TTC 1190
  const before = await inv(i.id);
  const pre = ok(await rs(i.id, { dryRun: true }));
  assert.equal(pre.preview.amount, '17.850'); assert.equal(pre.preview.base, before.totalTtc);
  assert.equal((await inv(i.id)).paidAmount, before.paidAmount, 'aperçu : rien n\'est écrit');

  const r = ok(await rs(i.id, { certificateNumber: 'ATT-77', notes: 'Oubli à l\'émission' }), 201);
  assert.equal(r.method, 'withholding'); assert.equal(r.amount, '17.850'); assert.equal(r.reference, 'ATT-77');
  const after1 = await inv(i.id);
  assert.equal(after1.withholdingAmount, before.withholdingAmount, 'la facture émise n\'est pas modifiée');
  assert.equal(after1.netPayable, before.netPayable); assert.equal(after1.totalTtc, before.totalTtc);
  assert.equal(after1.paidAmount, '17.850'); assert.equal(after1.addedWithholding.amount, '17.850'); assert.equal(after1.addedWithholding.rate, '1.50');
  assert.equal(after1.payments.find((p) => p.method === 'withholding').amount, '17.850');

  const list = ok(await c('GET', '/withholdings/sales', { token: A.token })).filter((x) => x.invoiceId === i.id);
  assert.equal(list.length, 1); assert.equal(list[0].amount, '17.850'); assert.equal(list[0].rate, '1.50'); assert.equal(list[0].added, true); assert.equal(list[0].certificate.number, 'ATT-77');
  ok(await c('PUT', `/withholdings/sales/${i.id}/certificate`, { token: A.token, body: { status: 'done', certificateNumber: 'ATT-77', certificateDate: today } }));

  assert.equal((await rs(i.id)).status, 409, 'une seule retenue ajoutée active');
  // le reste se règle normalement, la facture est soldée
  const rest = (Number(before.netPayable) - 17.85).toFixed(3);
  ok(await c('POST', '/payments', { token: A.token, body: { clientId: client.id, date: today, method: 'cash', allocations: [{ invoiceId: i.id, amount: rest }] } }), 201);
  assert.equal((await inv(i.id)).paymentStatus, 'paid');

  // annulation (motif) : le solde est rétabli et la retenue disparaît de la liste
  ok(await c('POST', `/payments/${r.id}/cancel`, { token: A.token, body: { reason: 'Saisie erronée du taux' } }));
  const after2 = await inv(i.id); assert.equal(after2.addedWithholding, null); assert.equal(after2.paidAmount, rest);
  assert.equal(ok(await c('GET', '/withholdings/sales', { token: A.token })).filter((x) => x.invoiceId === i.id).length, 0);
  assert.equal((await rs(i.id, { rate: '1' })).status, 201, 'nouvelle saisie possible après annulation');
});

test('refus : dépassement du reste à payer, retenue déjà sur la facture, brouillon, dates, mode manuel', async () => {
  const paid = await issued('100.000');
  ok(await c('POST', '/payments', { token: A.token, body: { clientId: client.id, date: today, method: 'cash', allocations: [{ invoiceId: paid.id, amount: (await inv(paid.id)).netPayable }] } }), 201);
  const x = await rs(paid.id); assert.equal(x.status, 422); assert.equal(x.body.error.code, 'WITHHOLDING_EXCEEDS_BALANCE');

  const withRs = await issued('100.000', { withholdingPct: '1.5' });
  assert.equal((await rs(withRs.id)).body.error.code, 'WITHHOLDING_ALREADY_ON_INVOICE');

  const draft = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ description: 'x', quantity: 1, unitPrice: '10', taxRateId: tax19.id }] } }), 201);
  assert.equal((await rs(draft.id)).status, 409);

  const fresh = await issued('100.000');
  assert.equal((await rs(fresh.id, { date: '2999-01-01' })).body.error.code, 'FUTURE_DATE');
  assert.equal((await rs(fresh.id, { date: '2000-01-01' })).body.error.code, 'DATE_BEFORE_ISSUE');
  for (const rate of ['0', '-1', '101', 'abc', '1.555']) assert.equal((await rs(fresh.id, { rate })).status, 400, `taux ${rate}`);
  const gen = await c('POST', '/payments', { token: A.token, body: { clientId: client.id, date: today, method: 'withholding', amount: '5', allocations: [] } });
  assert.equal(gen.status, 400, 'le mode withholding n\'est pas saisissable à la main');
  assert.ok(!ok(await c('GET', '/payments/methods', { token: A.token })).some((m) => m.code === 'withholding'));
});

test('isolation et droits : autre entreprise = 404, lecture seule = 403', async () => {
  const i = await issued('100.000');
  assert.equal((await rs(i.id, {}, B.token)).status, 404);
  assert.equal((await rs(i.id, {}, reader.token)).status, 403);
});

test('concurrence : 6 saisies simultanées de retenue sur la même facture → une seule', async () => {
  const i = await issued('100.000');
  const rsps = await Promise.all(Array.from({ length: 6 }, () => rs(i.id)));
  assert.ok(rsps.every((r) => r.status < 500), rsps.map((r) => r.status).join(','));
  assert.equal(rsps.filter((r) => r.status === 201).length, 1, rsps.map((r) => r.status).join(','));
  assert.equal((await inv(i.id)).paidAmount, '1.785');
});

test('achat : retenue ajoutée → liste achats + préparation TEJ du mois, exclue des encaissements', async () => {
  const p = ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: 'F-RS-ADD-1', lines: [{ description: 'Prestation', quantity: 1, unitPrice: '1000', taxRateId: tax19.id }] } }), 201);
  ok(await c('POST', `/purchase-invoices/${p.id}/record`, { token: A.token }));
  const r = ok(await c('POST', '/supplier-payments/withholding', { token: A.token, body: { invoiceId: p.id, rate: '1.5', date: today, certificateNumber: 'ATT-A1' } }), 201);
  assert.equal(r.amount, '17.850'); assert.equal(r.method, 'withholding');
  const d = ok(await c('GET', `/purchase-invoices/${p.id}`, { token: A.token }));
  assert.equal(d.withholdingAmount, '0.000'); assert.equal(d.addedWithholding.amount, '17.850'); assert.equal(d.paidAmount, '17.850');
  const list = ok(await c('GET', '/withholdings/purchases', { token: A.token })).find((x) => x.invoiceId === p.id);
  assert.equal(list.amount, '17.850'); assert.equal(list.added, true);
  const tej = await c('GET', `/withholdings/purchases/tej-prep?month=${month}`, { token: A.token });
  const row = tej.body.data.find((x) => x.invoiceId === p.id); assert.ok(row, tej.raw); assert.equal(row.retenue, '17850'); assert.equal(row.reference, 'ATT-A1');
  ok(await c('POST', `/supplier-payments/${r.id}/cancel`, { token: A.token, body: { reason: 'Retenue saisie à tort' } }));
  assert.ok(!(await c('GET', `/withholdings/purchases/tej-prep?month=${month}`, { token: A.token })).body.data.some((x) => x.invoiceId === p.id));
  // encaissements : la retenue n'est pas une entrée d'argent
  const col = await c('GET', `/reports/collections?from=${month}-01&to=${today}`, { token: A.token });
  if (col.status === 200) assert.ok(!JSON.stringify(col.body).includes('withholding'), 'retenue absente du rapport des encaissements');
});
