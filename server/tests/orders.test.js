import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';
import { nextDate } from '../src/modules/sales/recurring.service.js';

let app, A, B, readOnly, client, tax19, tax7;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const year = today.slice(0, 4);
const orderBody = (extra = {}) => ({ clientId: client.id, issueDate: today, lines: [
  { description: 'Licence logiciel', quantity: 10, unitPrice: '100.000', taxRateId: tax19.id },
  { description: 'Support', quantity: 4, unitPrice: '50.000', taxRateId: tax7.id }], ...extra });
const mkOrder = async (confirm = true) => {
  const o = (await c('POST', '/orders', { token: A.token, body: orderBody() })).body.data;
  if (!confirm) return o;
  const r = await c('POST', `/orders/${o.id}/confirm`, { token: A.token }); assert.equal(r.status, 200, r.raw); return r.body.data;
};
const pdf = async (path, token = A.token) => { const r = await fetch(app.base + path, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; };

before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Alpha'); B = await registerCompany(app.call, 'Beta');
  readOnly = await addMember(app.call, A, 'read_only');
  client = (await c('POST', '/clients', { token: A.token, body: { name: 'Client Commandes', paymentTermsDays: 30 } })).body.data;
  const taxes = (await c('GET', '/tax-rates', { token: A.token })).body.data;
  tax19 = taxes.find((t) => t.rate === '19.00'); tax7 = taxes.find((t) => t.rate === '7.00');
});
after(() => app.close());

test('commande : totaux serveur, confirmation, verrouillage, droits, isolation', async () => {
  const r = await c('POST', '/orders', { token: A.token, body: orderBody() });
  assert.equal(r.status, 201, r.raw);
  const o = r.body.data;
  assert.equal(o.status, 'draft'); assert.match(o.number, new RegExp(`^CMD-${year}-\\d{5}$`));
  assert.equal(o.totalHt, '1200.000'); assert.equal(o.totalTax, '204.000'); assert.equal(o.totalTtc, '1404.000');
  assert.equal(o.deliveryStatus, 'none'); assert.equal(o.invoicingStatus, 'none');
  assert.equal((await c('POST', '/orders', { token: readOnly.token, body: orderBody() })).status, 403);
  assert.equal((await c('GET', `/orders/${o.id}`, { token: B.token })).status, 404, 'isolation');
  assert.equal((await c('PUT', `/orders/${o.id}`, { token: A.token, body: orderBody({ notes: 'maj' }) })).status, 200);
  assert.equal((await c('POST', `/orders/${o.id}/confirm`, { token: A.token })).status, 200);
  assert.equal((await c('PUT', `/orders/${o.id}`, { token: A.token, body: orderBody() })).status, 409, 'verrouillée');
  assert.equal((await c('DELETE', `/orders/${o.id}`, { token: A.token })).status, 409);
  assert.equal((await c('POST', `/orders/${o.id}/cancel`, { token: A.token, body: { reason: 'xx' } })).status, 400);
  const draft = await mkOrder(false);
  assert.equal((await c('DELETE', `/orders/${draft.id}`, { token: A.token })).status, 204);
});

test('devis accepté -> commande, montants identiques, devis converti', async () => {
  const q = (await c('POST', '/quotes', { token: A.token, body: { clientId: client.id, issueDate: today, lines: orderBody().lines } })).body.data;
  assert.equal((await c('POST', `/orders/from-quote/${q.id}`, { token: A.token })).status, 409, 'devis non accepté');
  await c('POST', `/quotes/${q.id}/status`, { token: A.token, body: { status: 'sent' } });
  await c('POST', `/quotes/${q.id}/status`, { token: A.token, body: { status: 'accepted' } });
  const r = await c('POST', `/orders/from-quote/${q.id}`, { token: A.token });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.body.data.totalTtc, q.totalTtc); assert.equal(r.body.data.quote.id, q.id);
  assert.equal((await c('GET', `/quotes/${q.id}`, { token: A.token })).body.data.status, 'converted');
  assert.equal((await c('POST', `/orders/from-quote/${q.id}`, { token: A.token })).status, 409, 'une seule conversion');
});

let order, bl1, bl2;
test('bons de livraison : livraison partielle, plafonds, numérotation à la validation', async () => {
  order = await mkOrder();
  const [lA, lB] = order.lines;
  const draftOrder = await mkOrder(false);
  assert.equal((await c('POST', '/delivery-notes', { token: A.token, body: { orderId: draftOrder.id, deliveryDate: today, lines: [{ orderLineId: draftOrder.lines[0].id, quantity: 1 }] } })).status, 409, 'commande non confirmée');
  const mk = (lines) => c('POST', '/delivery-notes', { token: A.token, body: { orderId: order.id, deliveryDate: today, lines } });
  let r = await mk([{ orderLineId: lA.id, quantity: 6 }]);
  assert.equal(r.status, 201, r.raw); bl1 = r.body.data;
  assert.equal(bl1.status, 'draft'); assert.equal(bl1.number, null);
  assert.equal((await mk([{ orderLineId: lA.id, quantity: 5 }])).status, 422, 'dépasse le reste (6 déjà réservés)');
  assert.equal((await mk([{ orderLineId: 999999999, quantity: 1 }])).status, 422, 'ligne étrangère');
  assert.equal((await mk([{ orderLineId: lA.id, quantity: 1 }, { orderLineId: lA.id, quantity: 1 }])).status, 422, 'doublon');
  r = await c('POST', `/delivery-notes/${bl1.id}/validate`, { token: A.token });
  assert.equal(r.status, 200, r.raw); assert.match(r.body.data.number, new RegExp(`^BL-${year}-\\d{5}$`)); bl1 = r.body.data;
  assert.equal((await c('PUT', `/delivery-notes/${bl1.id}`, { token: A.token, body: { deliveryDate: today, lines: [{ orderLineId: lA.id, quantity: 1 }] } })).status, 409, 'validé = verrouillé');
  assert.equal((await c('GET', `/orders/${order.id}`, { token: A.token })).body.data.deliveryStatus, 'partial');
  r = await mk([{ orderLineId: lA.id, quantity: 4 }, { orderLineId: lB.id, quantity: 4 }]);
  assert.equal(r.status, 201, r.raw); bl2 = r.body.data;
  assert.equal((await c('POST', `/delivery-notes/${bl2.id}/validate`, { token: A.token })).status, 200);
  const o = (await c('GET', `/orders/${order.id}`, { token: A.token })).body.data;
  assert.equal(o.deliveryStatus, 'complete'); assert.equal(o.lines[0].remainingQuantity, '0.0000');
  assert.equal((await mk([{ orderLineId: lA.id, quantity: 1 }])).status, 422, 'plus rien à livrer');
  assert.equal((await c('POST', `/orders/${order.id}/cancel`, { token: A.token, body: { reason: 'client parti' } })).status, 409, 'livraisons existantes');
  assert.equal((await c('GET', `/delivery-notes/${bl1.id}`, { token: B.token })).status, 404, 'isolation');
  const list = await c('GET', `/delivery-notes?orderId=${order.id}`, { token: A.token });
  assert.equal(list.body.meta.total, 2);
});

test('facture depuis un bon de livraison : quantités livrées, une seule fois, annulation libère le bon', async () => {
  let r = await c('POST', `/delivery-notes/${bl1.id}/invoice`, { token: A.token });
  assert.equal(r.status, 201, r.raw);
  const inv = (await c('GET', `/invoices/${r.body.data.invoiceId}`, { token: A.token })).body.data;
  assert.equal(inv.status, 'draft'); assert.equal(inv.lines.length, 1); assert.equal(inv.lines[0].quantity, '6.0000');
  assert.equal(inv.totalHt, '600.000'); assert.equal(inv.totalTtc, '714.000'); assert.equal(inv.deliveryNote.number, bl1.number);
  assert.equal((await c('POST', `/delivery-notes/${bl1.id}/invoice`, { token: A.token })).status, 409, 'déjà facturé');
  assert.equal((await c('POST', `/orders/${order.id}/invoice`, { token: A.token })).status, 409, 'facturation par livraison en cours');
  assert.equal((await c('POST', `/delivery-notes/${bl1.id}/cancel`, { token: A.token, body: { reason: 'erreur de saisie' } })).status, 409, 'facture liée');
  assert.equal((await c('POST', `/invoices/${inv.id}/issue`, { token: A.token })).status, 200);
  assert.equal((await c('POST', `/invoices/${inv.id}/cancel`, { token: A.token, body: { reason: 'refacturer autrement' } })).status, 200);
  r = await c('POST', `/delivery-notes/${bl1.id}/invoice`, { token: A.token });
  assert.equal(r.status, 201, 'le bon redevient facturable après annulation');
});

test('acompte puis solde : acompte par taux de TVA, déduction TTC, garde-fous', async () => {
  const o = await mkOrder();
  assert.equal((await c('POST', `/orders/${o.id}/deposit`, { token: A.token, body: { pct: 0 } })).status, 400);
  assert.equal((await c('POST', `/orders/${o.id}/deposit`, { token: A.token, body: { pct: 101 } })).status, 400);
  const d = await c('POST', `/orders/${o.id}/deposit`, { token: A.token, body: { pct: 30 } });
  assert.equal(d.status, 201, d.raw);
  const dep = (await c('GET', `/invoices/${d.body.data.invoiceId}`, { token: A.token })).body.data;
  assert.equal(dep.invoiceType, 'deposit'); assert.equal(dep.depositPct, '30.00');
  assert.equal(dep.totalHt, '360.000'); assert.equal(dep.totalTax, '61.200'); assert.equal(dep.totalTtc, '421.200');
  assert.deepEqual(dep.taxes.map((t) => [t.taxRate, t.base, t.amount]), [['7.00', '60.000', '4.200'], ['19.00', '300.000', '57.000']]);
  assert.equal((await c('POST', `/orders/${o.id}/deposit`, { token: A.token, body: { pct: 80 } })).status, 422, 'cumul > 100 %');
  assert.equal((await c('POST', `/orders/${o.id}/invoice`, { token: A.token })).status, 409, 'acompte non émis');
  assert.equal((await c('POST', `/invoices/${dep.id}/issue`, { token: A.token })).status, 200);
  const f = await c('POST', `/orders/${o.id}/invoice`, { token: A.token });
  assert.equal(f.status, 201, f.raw);
  const fin = (await c('GET', `/invoices/${f.body.data.invoiceId}`, { token: A.token })).body.data;
  assert.equal(fin.invoiceType, 'final'); assert.equal(fin.totalTtc, '1404.000'); assert.equal(fin.depositDeducted, '421.200'); assert.equal(fin.netPayable, '982.800');
  assert.equal(fin.deposits.length, 1); assert.equal(fin.deposits[0].number, (await c('GET', `/invoices/${dep.id}`, { token: A.token })).body.data.number);
  assert.equal((await c('PUT', `/invoices/${fin.id}`, { token: A.token, body: { clientId: client.id, issueDate: today, lines: orderBody().lines, notes: 'relu' } })).body.data.netPayable, '982.800', 'la déduction survit à une modification');
  assert.equal((await c('POST', `/invoices/${dep.id}/cancel`, { token: A.token, body: { reason: 'tentative' } })).status, 409, 'acompte déduit');
  assert.equal((await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: dep.id, reason: 'tentative' } })).status, 409);
  assert.equal((await c('POST', `/orders/${o.id}/invoice`, { token: A.token })).status, 409, 'déjà facturée');
  const iss = await c('POST', `/invoices/${fin.id}/issue`, { token: A.token });
  assert.equal(iss.status, 200, iss.raw); assert.equal(iss.body.data.balance, '982.800');
  const p = await pdf(`/invoices/${fin.id}/pdf`); assert.equal(p.status, 200); assert.equal(p.buf.subarray(0, 4).toString(), '%PDF');
  // un avoir sur la facture de solde est plafonné au net réellement dû
  const cn = await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: fin.id, reason: 'geste commercial' } });
  assert.equal(cn.status, 422, 'avoir total > net à payer');
});

test('facture de solde annulée : l\'acompte redevient déductible', async () => {
  const o = await mkOrder();
  const dep = (await c('POST', `/orders/${o.id}/deposit`, { token: A.token, body: { pct: 50 } })).body.data.invoiceId;
  await c('POST', `/invoices/${dep}/issue`, { token: A.token });
  const f1 = (await c('POST', `/orders/${o.id}/invoice`, { token: A.token })).body.data.invoiceId;
  assert.equal((await c('DELETE', `/invoices/${dep}`, { token: A.token })).status, 409);
  await c('POST', `/invoices/${f1}/issue`, { token: A.token });
  assert.equal((await c('POST', `/invoices/${f1}/cancel`, { token: A.token, body: { reason: 'erreur de prix' } })).status, 200);
  const f2 = await c('POST', `/orders/${o.id}/invoice`, { token: A.token });
  assert.equal(f2.status, 201, f2.raw);
  assert.equal((await c('GET', `/invoices/${f2.body.data.invoiceId}`, { token: A.token })).body.data.depositDeducted, '702.000');
});

test('factures récurrentes : brouillons seulement, rattrapage, idempotence, pause', async () => {
  const start = [...Array(2)].reduce((d) => d, today); // base
  const [y, m, d] = today.split('-').map(Number);
  const startDate = new Date(Date.UTC(y, m - 3, Math.min(d, 28))).toISOString().slice(0, 10);
  let expected = 0; for (let p = startDate; p <= today; p = nextDate(p, 'monthly', startDate)) expected += 1;
  assert.ok(start && expected >= 2);
  const body = { clientId: client.id, name: 'Maintenance mensuelle', frequency: 'monthly', startDate, template: { lines: [{ description: 'Maintenance', quantity: 1, unitPrice: '200.000', taxRateId: tax19.id }], notes: 'Abonnement' } };
  assert.equal((await c('POST', '/recurring-invoices', { token: readOnly.token, body })).status, 403);
  assert.equal((await c('POST', '/recurring-invoices', { token: A.token, body: { ...body, template: { lines: [] } } })).status, 400);
  assert.equal((await c('POST', '/recurring-invoices', { token: A.token, body: { ...body, endDate: '2000-01-01' } })).status, 400);
  const r = await c('POST', '/recurring-invoices', { token: A.token, body });
  assert.equal(r.status, 201, r.raw); const rec = r.body.data;
  assert.equal(rec.status, 'active'); assert.equal(rec.nextRunDate, startDate);
  assert.equal((await c('GET', `/recurring-invoices/${rec.id}`, { token: B.token })).status, 404, 'isolation');
  const run = await c('POST', '/recurring-invoices/run-due', { token: A.token });
  assert.equal(run.status, 200, run.raw); assert.equal(run.body.data.generated, expected); assert.deepEqual(run.body.data.failed, []);
  assert.equal((await c('POST', '/recurring-invoices/run-due', { token: A.token })).body.data.generated, 0, 'idempotent');
  const det = (await c('GET', `/recurring-invoices/${rec.id}`, { token: A.token })).body.data;
  assert.equal(det.runCount, expected); assert.equal(det.runs.length, expected); assert.ok(det.nextRunDate > today);
  assert.ok(det.runs.every((x) => x.status === 'draft' && x.number === null), 'jamais émises automatiquement');
  const inv = (await c('GET', `/invoices/${det.runs[0].invoiceId}`, { token: A.token })).body.data;
  assert.equal(inv.totalTtc, '238.000'); assert.equal(inv.recurring.id, rec.id); assert.equal(inv.notes, 'Abonnement');
  assert.equal((await c('DELETE', `/recurring-invoices/${rec.id}`, { token: A.token })).status, 409, 'a déjà généré');
  assert.equal((await c('POST', `/recurring-invoices/${rec.id}/pause`, { token: A.token })).body.data.status, 'paused');
  assert.equal((await c('POST', `/recurring-invoices/${rec.id}/pause`, { token: A.token })).status, 409);
  assert.equal((await c('POST', `/recurring-invoices/${rec.id}/resume`, { token: A.token })).body.data.status, 'active');
  assert.equal((await c('POST', `/recurring-invoices/${rec.id}/end`, { token: A.token })).body.data.status, 'ended');
  // série à terme : se termine d'elle-même
  const one = (await c('POST', '/recurring-invoices', { token: A.token, body: { ...body, name: 'Unique', frequency: 'yearly', startDate: today, endDate: today } })).body.data;
  const g = (await c('POST', `/recurring-invoices/${one.id}/run`, { token: A.token })).body.data;
  assert.equal(g.generated, 1); assert.equal((await c('GET', `/recurring-invoices/${one.id}`, { token: A.token })).body.data.status, 'ended');
});

test('nextDate conserve le jour de départ (fin de mois)', () => {
  assert.equal(nextDate('2026-01-31', 'monthly', '2026-01-31'), '2026-02-28');
  assert.equal(nextDate('2026-02-28', 'monthly', '2026-01-31'), '2026-03-31');
  assert.equal(nextDate('2026-11-30', 'quarterly', '2026-11-30'), '2027-02-28');
  assert.equal(nextDate('2026-12-25', 'weekly', '2026-12-25'), '2027-01-01');
  assert.equal(nextDate('2028-02-29', 'yearly', '2028-02-29'), '2029-02-28');
});

test('modèle PDF unique « Classique pro » : français uniquement', async () => {
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { template: 'fancy' } } })).status, 400);
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { pdfLanguage: 'en' } } })).status, 400);
  const inv = (await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ description: 'خدمة تطوير', quantity: 1, unitPrice: '10', taxRateId: tax19.id }] } })).body.data;
  const sizes = new Set();
  for (const lang of ['fr', 'ar']) {
    const p = await pdf(`/invoices/${inv.id}/pdf?lang=${lang}`);
    assert.equal(p.status, 200); assert.equal(p.type, 'application/pdf'); assert.equal(p.buf.subarray(0, 4).toString(), '%PDF'); sizes.add(p.buf.length);
  }
  assert.equal(sizes.size, 1, 'français uniquement');
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { template: 'modern', pdfLanguage: 'ar' } } })).status, 400);
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { template: 'modern' } } })).status, 200);
  assert.equal((await pdf(`/invoices/${inv.id}/pdf`)).status, 200, 'préférence enregistrée');
  for (const path of [`/orders/${order.id}/pdf`, `/delivery-notes/${bl1.id}/pdf`]) { const p = await pdf(path); assert.equal(p.status, 200, path); assert.equal(p.type, 'application/pdf'); }
});
