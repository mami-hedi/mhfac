import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';
import { computeDocument } from '../src/core/calc.js';

let app, A, B, readOnly, tax19, tax7, cli, prodFodec, prodPlain, svc;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const L = (p, q, price, extra = {}) => ({ productId: p?.id, description: p?.name ?? 'Prestation', quantity: q, unitPrice: price, ...extra });

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Fodec A'); B = await registerCompany(app.call, 'Fodec B'); readOnly = await addMember(app.call, A, 'read_only');
  const taxes = ok(await c('GET', '/tax-rates', { token: A.token })); tax19 = taxes.find((t) => t.rate === '19.00'); tax7 = taxes.find((t) => t.rate === '7.00');
  cli = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Fodec' } }), 201);
  prodFodec = ok(await c('POST', '/products', { token: A.token, body: { name: 'Meuble local', salePrice: '1000', taxRateId: tax19.id, fodecSubject: true } }), 201);
  prodPlain = ok(await c('POST', '/products', { token: A.token, body: { name: 'Article libre', salePrice: '500', taxRateId: tax19.id } }), 201);
  svc = ok(await c('POST', '/products', { token: A.token, body: { name: 'Conseil', type: 'service', salePrice: '100', taxRateId: tax19.id, fodecSubject: true } }), 201);
});
after(() => app.close());

test('moteur : FODEC avant la TVA (exemple officiel), remise globale, taux multiples, taux 0', () => {
  const r = computeDocument({ lines: [{ quantity: 1, unitPrice: '1000', taxRate: 19, fodec: true }], stampDuty: '1', fodecRate: '1' });
  assert.deepEqual([r.totalHt, r.fodecAmount, r.totalTax, r.totalTtc, r.netPayable], ['1000.000', '10.000', '191.900', '1201.900', '1202.900']);
  assert.deepEqual(r.taxes, [{ taxRate: '19.00', base: '1010.000', amount: '191.900' }]);
  const m = computeDocument({ lines: [{ quantity: 1, unitPrice: '1000', taxRate: 19, fodec: true }, { quantity: 1, unitPrice: '500', taxRate: 19 }, { quantity: 1, unitPrice: '200', taxRate: 7, fodec: true }], globalDiscountPct: '10', fodecRate: '1' });
  assert.deepEqual([m.totalHt, m.fodecAmount, m.totalTax, m.totalTtc], ['1530.000', '10.800', '270.936', '1811.736']);
  const z = computeDocument({ lines: [{ quantity: 1, unitPrice: '1000', taxRate: 19, fodec: true }] });
  assert.equal(z.fodecAmount, '0.000'); assert.equal(z.totalTtc, '1190.000', 'sans taux : calcul inchangé');
  assert.throws(() => computeDocument({ lines: [], fodecRate: '101' }));
});

test('désactivé par défaut ; activation dans Paramètres ; article soumis, ligne libre, service, case de ligne', async () => {
  const body = (lines) => ({ clientId: cli.id, issueDate: today, lines });
  let d = ok(await c('POST', '/invoices', { token: A.token, body: body([L(prodFodec, 1, '1000')]) }), 201);
  assert.equal(d.fodecAmount, '0.000', 'module désactivé : aucun FODEC'); assert.equal(d.totalTtc, '1190.000');
  assert.equal(ok(await c('GET', '/companies/current/settings', { token: A.token })).sales.fodecEnabled, false);
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { sales: { fodecRate: '150' } } })).status, 400);
  assert.equal((await c('PATCH', '/companies/current/settings', { token: readOnly.token, body: { sales: { fodecEnabled: true } } })).status, 403);
  ok(await c('PATCH', '/companies/current/settings', { token: A.token, body: { sales: { fodecEnabled: true, fodecRate: '1.00' } } }));
  assert.equal(ok(await c('GET', `/products/${prodFodec.id}`, { token: A.token })).fodecSubject, true);
  assert.equal(ok(await c('GET', `/products/${svc.id}`, { token: A.token })).fodecSubject, false, 'un service n\'est jamais soumis');
  // article soumis : 1 000 -> FODEC 10 ; article non soumis et ligne libre : rien ; case de ligne prioritaire
  d = ok(await c('POST', '/invoices', { token: A.token, body: body([L(prodFodec, 1, '1000'), L(prodPlain, 1, '500'), { description: 'Libre', quantity: 1, unitPrice: '100', taxRateId: tax19.id }]) }), 201);
  assert.equal(d.fodecAmount, '10.000'); assert.equal(d.fodecRate, '1.00'); assert.equal(d.totalHt, '1600.000'); assert.equal(d.totalTax, '305.900'); assert.equal(d.totalTtc, '1915.900');
  assert.deepEqual(d.lines.map((l) => l.fodec), [true, false, false]); assert.equal(d.taxes[0].base, '1610.000');
  d = ok(await c('POST', '/invoices', { token: A.token, body: body([L(prodFodec, 1, '1000', { fodec: false }), L(prodPlain, 1, '500', { fodec: true })]) }), 201);
  assert.equal(d.fodecAmount, '5.000'); assert.deepEqual(d.lines.map((l) => l.fodec), [false, true]);
  // l'aperçu serveur donne les mêmes chiffres ; une valeur envoyée par le client n'est jamais lue
  const pv = ok(await c('POST', '/sales/preview', { token: A.token, body: { ...body([L(prodFodec, 1, '1000')]), fodecAmount: '999', totalTtc: '1' } }));
  assert.equal(pv.fodecAmount, '10.000'); assert.equal(pv.totalTtc, '1201.900');
  // mise à jour d'un brouillon : recalcul
  const upd = ok(await c('PUT', `/invoices/${d.id}`, { token: A.token, body: body([L(prodFodec, 2, '1000')]) }));
  assert.equal(upd.fodecAmount, '20.000'); assert.equal(upd.totalTtc, '2403.800');
  // un client d'une autre entreprise ne voit pas le réglage de A
  assert.equal(ok(await c('GET', '/companies/current/settings', { token: B.token })).sales.fodecEnabled, false);
});

test('devis -> commande -> facture : FODEC conservé, émission, avoir partiel, solde client', async () => {
  const q = ok(await c('POST', '/quotes', { token: A.token, body: { clientId: cli.id, issueDate: today, lines: [L(prodFodec, 2, '1000', { taxRateId: tax19.id })] } }), 201);
  assert.equal(q.fodecAmount, '20.000'); assert.equal(q.totalTtc, '2403.800');
  ok(await c('POST', `/quotes/${q.id}/status`, { token: A.token, body: { status: 'sent' } })); ok(await c('POST', `/quotes/${q.id}/status`, { token: A.token, body: { status: 'accepted' } }));
  const conv = ok(await c('POST', `/quotes/${q.id}/convert`, { token: A.token }), 201);
  const inv0 = ok(await c('GET', `/invoices/${conv.invoiceId}`, { token: A.token }));
  assert.equal(inv0.fodecAmount, '20.000'); assert.equal(inv0.totalTtc, '2403.800'); assert.deepEqual(inv0.lines.map((l) => l.fodec), [true]);
  ok(await c('POST', `/invoices/${inv0.id}/issue`, { token: A.token }));
  const inv = ok(await c('GET', `/invoices/${inv0.id}`, { token: A.token })); assert.equal(inv.status, 'issued'); assert.equal(inv.fodecAmount, '20.000');
  // avoir d'une unité sur deux : FODEC proportionnel (10), TVA sur 1 010
  const cn = ok(await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: inv.id, reason: 'Retour', lines: [{ invoiceLineId: inv.lines[0].id, quantity: 1 }] } }), 201);
  assert.equal(cn.fodecAmount, '10.000'); assert.equal(cn.totalHt, '1000.000'); assert.equal(cn.totalTax, '191.900'); assert.equal(cn.totalTtc, '1201.900');
  ok(await c('POST', `/credit-notes/${cn.id}/issue`, { token: A.token }));
  // l'avoir complet restant ne dépasse jamais la facture
  const cn2 = ok(await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: inv.id, reason: 'Solde', lines: [{ invoiceLineId: inv.lines[0].id, quantity: 1 }] } }), 201);
  assert.equal(cn2.totalTtc, '1201.900');
  // solde client : facture 2 403,800 - avoir émis 1 201,900
  const bal = ok(await c('GET', '/client-balances', { token: A.token }));
  assert.ok(bal.length >= 1);
  // isolation
  assert.equal((await c('GET', `/invoices/${inv.id}`, { token: B.token })).status, 404);
});
