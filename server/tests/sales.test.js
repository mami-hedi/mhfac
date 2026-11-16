import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, accountant, readOnly, client, product, tax19, tax7;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const year = today.slice(0, 4);
const line = (extra = {}) => ({ description: 'Prestation', quantity: 2, unitPrice: '100.000', ...extra });
const invBody = (extra = {}) => ({ clientId: client.id, issueDate: today, lines: [line({ taxRateId: tax19.id })], ...extra });

before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Alpha'); B = await registerCompany(app.call, 'Beta');
  accountant = await addMember(app.call, A, 'accountant'); readOnly = await addMember(app.call, A, 'read_only');
  client = (await c('POST', '/clients', { token: A.token, body: { name: 'Client Test SARL', taxId: '9999999/A/M/000', paymentTermsDays: 30 } })).body.data;
  const taxes = (await c('GET', '/tax-rates', { token: A.token })).body.data;
  tax19 = taxes.find((t) => t.rate === '19.00'); tax7 = taxes.find((t) => t.rate === '7.00');
  product = (await c('POST', '/products', { token: A.token, body: { name: 'Clavier', salePrice: '50', taxRateId: tax7.id } })).body.data;
});
after(() => app.close());

test('paramètres : timbre désactivé et à 0 par défaut, modifiable, validé', async () => {
  const g = await c('GET', '/companies/current/settings', { token: A.token });
  assert.equal(g.body.data.sales.stampDutyEnabled, false); assert.equal(g.body.data.sales.stampDutyAmount, '0.000');
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { sales: { stampDutyAmount: 'abc' } } })).status, 400);
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { accentColor: 'rouge' } } })).status, 400);
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { logo: 'data:text/html;base64,AAAA' } } })).status, 400);
  assert.equal((await c('PATCH', '/companies/current/settings', { token: readOnly.token, body: { sales: { quoteValidityDays: 10 } } })).status, 403);
  const ok = await c('PATCH', '/companies/current/settings', { token: A.token, body: { sales: { quoteValidityDays: 15, paymentInfo: 'RIB 00 000 0000' }, identity: { address: '1 rue de Tunis', phone: '71000000' } } });
  assert.equal(ok.status, 200); assert.equal(ok.body.data.sales.quoteValidityDays, 15);
  assert.equal((await c('GET', '/companies/current/settings', { token: B.token })).body.data.sales.quoteValidityDays, 30, 'isolation');
});

test('facture brouillon : totaux calculés par le serveur, totaux du client ignorés', async () => {
  const r = await c('POST', '/invoices', { token: A.token, body: invBody({ totalTtc: '1.000', totalHt: '1', netPayable: '1', lines: [line({ taxRateId: tax19.id, netAmount: '1.000' })] }) });
  assert.equal(r.status, 201, r.raw);
  const d = r.body.data;
  assert.equal(d.status, 'draft'); assert.equal(d.number, null);
  assert.equal(d.totalHt, '200.000'); assert.equal(d.totalTax, '38.000'); assert.equal(d.totalTtc, '238.000'); assert.equal(d.netPayable, '238.000');
  assert.equal(d.dueDate, new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10), 'échéance = délai du client');
  assert.deepEqual(d.taxes, [{ taxRate: '19.00', base: '200.000', amount: '38.000' }]);
});

test('ligne depuis un article : prix, TVA et désignation repris', async () => {
  const r = await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ productId: product.id, quantity: 3 }] } });
  assert.equal(r.status, 201, r.raw);
  const l = r.body.data.lines[0];
  assert.equal(l.description, 'Clavier'); assert.equal(l.unitPrice, '50.000'); assert.equal(l.taxRate, '7.00'); assert.equal(r.body.data.totalTtc, '160.500');
});

test('validations : lignes vides, client/produit/taux d\'une autre société, remise > 100', async () => {
  assert.equal((await c('POST', '/invoices', { token: A.token, body: invBody({ lines: [] }) })).status, 400);
  assert.equal((await c('POST', '/invoices', { token: A.token, body: invBody({ lines: [line({ quantity: 0 })] }) })).status, 400);
  assert.equal((await c('POST', '/invoices', { token: A.token, body: invBody({ lines: [line({ discountPct: 101 })] }) })).status, 400);
  assert.equal((await c('POST', '/invoices', { token: A.token, body: invBody({ lines: [line({ unitPrice: '1.2345' })] }) })).status, 400);
  assert.equal((await c('POST', '/invoices', { token: A.token, body: invBody({ issueDate: '2026-02-31' }) })).status, 400);
  assert.equal((await c('POST', '/invoices', { token: B.token, body: invBody() })).status, 422, 'client d\'une autre société');
  const taxB = (await c('GET', '/tax-rates', { token: B.token })).body.data[0];
  const clientB = (await c('POST', '/clients', { token: B.token, body: { name: 'Client B' } })).body.data;
  assert.equal((await c('POST', '/invoices', { token: B.token, body: { clientId: clientB.id, issueDate: today, lines: [line({ taxRateId: tax19.id })] } })).status, 422, 'taux d\'une autre société');
  assert.equal((await c('POST', '/invoices', { token: B.token, body: { clientId: clientB.id, issueDate: today, lines: [{ productId: product.id, quantity: 1 }] } })).status, 422, 'article d\'une autre société');
  assert.equal((await c('POST', '/invoices', { token: B.token, body: { clientId: clientB.id, issueDate: today, lines: [line({ taxRateId: taxB.id })] } })).status, 201);
});

test('timbre fiscal et retenue : appliqués selon les paramètres, jamais en dur', async () => {
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { sales: { stampDutyEnabled: true, stampDutyAmount: '1.000' } } });
  const r = await c('POST', '/invoices', { token: A.token, body: invBody({ withholdingPct: 1.5 }) });
  const d = r.body.data;
  assert.equal(d.stampDuty, '1.000'); assert.equal(d.withholdingAmount, '3.570'); assert.equal(d.netPayable, '235.430');
  const none = await c('POST', '/invoices', { token: A.token, body: invBody({ applyStampDuty: false }) });
  assert.equal(none.body.data.stampDuty, '0.000');
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { sales: { stampDutyEnabled: false } } });
});

test('devise étrangère : taux de change obligatoire et conservé', async () => {
  assert.equal((await c('POST', '/invoices', { token: A.token, body: invBody({ currency: 'EUR' }) })).status, 422);
  const r = await c('POST', '/invoices', { token: A.token, body: invBody({ currency: 'EUR', exchangeRate: '3.4' , applyStampDuty: true }) });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.body.data.currency, 'EUR'); assert.equal(r.body.data.exchangeRate, '3.400000'); assert.equal(r.body.data.stampDuty, '0.000', 'pas de timbre hors devise de l\'entreprise');
});

let invoice;
test('émission : numéro FAC-AAAA-00001, figeage, rôle comptable', async () => {
  const d = (await c('POST', '/invoices', { token: A.token, body: invBody({ applyStampDuty: false }) })).body.data;
  assert.equal((await c('POST', `/invoices/${d.id}/issue`, { token: readOnly.token })).status, 403);
  assert.equal((await c('POST', `/invoices/${d.id}/issue`, { token: B.token })).status, 404);
  const r = await c('POST', `/invoices/${d.id}/issue`, { token: accountant.token });
  assert.equal(r.status, 200, r.raw);
  invoice = r.body.data;
  assert.match(invoice.number, new RegExp(`^FAC-${year}-\\d{5}$`)); assert.equal(invoice.status, 'issued');
  assert.equal(invoice.client.name, 'Client Test SARL'); assert.ok(invoice.company);
  assert.equal(invoice.paymentStatus, 'unpaid'); assert.equal(invoice.balance, '238.000');
  assert.equal((await c('POST', `/invoices/${d.id}/issue`, { token: A.token })).status, 409, 'double émission');
});

test('immutabilité : une facture émise ne se modifie ni ne se supprime', async () => {
  assert.equal((await c('PUT', `/invoices/${invoice.id}`, { token: A.token, body: invBody({ lines: [line({ unitPrice: 1, taxRateId: tax19.id })] }) })).status, 409);
  assert.equal((await c('DELETE', `/invoices/${invoice.id}`, { token: A.token })).status, 409);
  const after = (await c('GET', `/invoices/${invoice.id}`, { token: A.token })).body.data;
  assert.equal(after.totalTtc, '238.000');
  // un changement ultérieur du client ou du taux ne touche pas la facture émise
  await c('PATCH', `/clients/${client.id}`, { token: A.token, body: { name: 'Client Renommé' } });
  const again = (await c('GET', `/invoices/${invoice.id}`, { token: A.token })).body.data;
  assert.equal(again.client.name, 'Client Test SARL');
  await c('PATCH', `/clients/${client.id}`, { token: A.token, body: { name: 'Client Test SARL' } });
});

test('numérotation continue, ordre chronologique, concurrence', async () => {
  const drafts = await Promise.all(Array.from({ length: 5 }, () => c('POST', '/invoices', { token: A.token, body: invBody() })));
  const issued = await Promise.all(drafts.map((d) => c('POST', `/invoices/${d.body.data.id}/issue`, { token: A.token })));
  assert.ok(issued.every((r) => r.status === 200), JSON.stringify(issued.map((r) => r.status)));
  const nums = issued.map((r) => r.body.data.number).sort();
  assert.equal(new Set(nums).size, 5);
  const seq = nums.map((n) => Number(n.split('-')[2]));
  assert.equal(seq[4] - seq[0], 4, 'séquence continue');
  const past = await c('POST', '/invoices', { token: A.token, body: invBody({ issueDate: `${year}-01-01` }) });
  assert.equal((await c('POST', `/invoices/${past.body.data.id}/issue`, { token: A.token })).status, 409, 'date antérieure au dernier document émis');
  const future = await c('POST', '/invoices', { token: A.token, body: invBody({ issueDate: `${Number(year) + 1}-01-01` }) });
  assert.equal((await c('POST', `/invoices/${future.body.data.id}/issue`, { token: A.token })).status, 409);
  assert.equal((await c('DELETE', `/invoices/${past.body.data.id}`, { token: A.token })).status, 204, 'brouillon supprimable sans trou');
});

test('annulation encadrée : motif obligatoire, numéro conservé', async () => {
  const d = (await c('POST', '/invoices', { token: A.token, body: invBody() })).body.data;
  const iss = (await c('POST', `/invoices/${d.id}/issue`, { token: A.token })).body.data;
  assert.equal((await c('POST', `/invoices/${iss.id}/cancel`, { token: A.token, body: { reason: 'x' } })).status, 400);
  assert.equal((await c('POST', `/invoices/${iss.id}/cancel`, { token: readOnly.token, body: { reason: 'Erreur de saisie' } })).status, 403);
  const r = await c('POST', `/invoices/${iss.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie client' } });
  assert.equal(r.status, 200); assert.equal(r.body.data.status, 'cancelled'); assert.equal(r.body.data.number, iss.number); assert.equal(r.body.data.cancelReason, 'Erreur de saisie client');
  assert.equal((await c('POST', `/invoices/${iss.id}/cancel`, { token: A.token, body: { reason: 'Encore une fois' } })).status, 409);
});

let cn;
test('avoir : partiel puis plafonné, émission, effet sur le solde', async () => {
  const line1 = invoice.lines[0];
  assert.equal((await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: invoice.id, reason: 'Trop', lines: [{ invoiceLineId: line1.id, quantity: 3 }] } })).status, 422, 'plus que facturé');
  assert.equal((await c('POST', '/credit-notes', { token: readOnly.token, body: { invoiceId: invoice.id, reason: 'Non', lines: [{ invoiceLineId: line1.id, quantity: 1 }] } })).status, 403);
  assert.equal((await c('POST', '/credit-notes', { token: B.token, body: { invoiceId: invoice.id, reason: 'Non', lines: [{ invoiceLineId: line1.id, quantity: 1 }] } })).status, 404);
  const r = await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: invoice.id, reason: 'Retour partiel', lines: [{ invoiceLineId: line1.id, quantity: 1 }] } });
  assert.equal(r.status, 201, r.raw);
  cn = r.body.data;
  assert.equal(cn.status, 'draft'); assert.equal(cn.totalHt, '100.000'); assert.equal(cn.totalTtc, '119.000'); assert.equal(cn.creditedInvoice.number, invoice.number);
  assert.equal((await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: invoice.id, reason: 'Reste', lines: [{ invoiceLineId: line1.id, quantity: 1.5 }] } })).status, 422, 'le brouillon compte dans le plafond');
  const iss = await c('POST', `/credit-notes/${cn.id}/issue`, { token: A.token });
  assert.equal(iss.status, 200, iss.raw); assert.match(iss.body.data.number, new RegExp(`^AVO-${year}-00001$`));
  const inv = (await c('GET', `/invoices/${invoice.id}`, { token: A.token })).body.data;
  assert.equal(inv.balance, '119.000'); assert.equal(inv.creditNotes.length, 1);
  assert.equal((await c('POST', `/invoices/${invoice.id}/cancel`, { token: A.token, body: { reason: 'Après avoir' } })).status, 409, 'annulation refusée si avoir');
  assert.equal((await c('GET', `/invoices/${cn.id}`, { token: A.token })).status, 404, 'un avoir n\'est pas lisible via /invoices');
  const rest = await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: invoice.id, reason: 'Solde' } });
  assert.equal(rest.status, 201); assert.equal(rest.body.data.totalTtc, '119.000', 'sans lignes : tout le reste');
  await c('POST', `/credit-notes/${rest.body.data.id}/issue`, { token: A.token });
  const full = (await c('GET', `/invoices/${invoice.id}`, { token: A.token })).body.data;
  assert.equal(full.balance, '0.000'); assert.equal(full.paymentStatus, 'credited');
  assert.equal((await c('POST', '/credit-notes', { token: A.token, body: { invoiceId: invoice.id, reason: 'Encore' } })).status, 409, 'déjà entièrement créditée');
  assert.equal((await c('DELETE', `/credit-notes/${rest.body.data.id}`, { token: A.token })).status, 409, 'avoir émis conservé');
});

let quote;
test('devis : création, numéro DEV, statuts, expiration', async () => {
  const r = await c('POST', '/quotes', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [line({ taxRateId: tax19.id }), { productId: product.id, quantity: 1 }] } });
  assert.equal(r.status, 201, r.raw); quote = r.body.data;
  assert.match(quote.number, new RegExp(`^DEV-${year}-\\d{5}$`)); assert.equal(quote.totalHt, '250.000'); assert.equal(quote.validUntil, new Date(Date.parse(`${today}T00:00:00Z`) + 15 * 86400000).toISOString().slice(0, 10));
  assert.equal((await c('POST', `/quotes/${quote.id}/status`, { token: A.token, body: { status: 'accepted' } })).status, 409, 'draft -> accepted impossible');
  assert.equal((await c('POST', `/quotes/${quote.id}/convert`, { token: A.token })).status, 409, 'pas accepté');
  assert.equal((await c('POST', `/quotes/${quote.id}/status`, { token: A.token, body: { status: 'sent' } })).status, 200);
  const up = await c('PUT', `/quotes/${quote.id}`, { token: A.token, body: { clientId: client.id, issueDate: today, lines: [line({ taxRateId: tax19.id })] } });
  assert.equal(up.status, 200); assert.equal(up.body.data.totalHt, '200.000');
  const old = await c('POST', '/quotes', { token: A.token, body: { clientId: client.id, issueDate: '2025-01-01', validUntil: '2025-01-15', lines: [line({ taxRateId: tax19.id })] } });
  assert.equal(old.body.data.status, 'expired');
  assert.equal((await c('GET', '/quotes?status=expired', { token: A.token })).body.data.some((q) => q.id === old.body.data.id), true);
  assert.equal((await c('POST', '/quotes', { token: A.token, body: { clientId: client.id, issueDate: today, validUntil: '2020-01-01', lines: [line({ taxRateId: tax19.id })] } })).status, 422);
  assert.equal((await c('GET', `/quotes/${quote.id}`, { token: B.token })).status, 404);
  assert.equal((await c('POST', '/quotes', { token: readOnly.token, body: { clientId: client.id, issueDate: today, lines: [line()] } })).status, 403);
});

test('devis accepté -> facture sans ressaisie ; devis verrouillé ensuite', async () => {
  await c('POST', `/quotes/${quote.id}/status`, { token: A.token, body: { status: 'accepted' } });
  const r = await c('POST', `/quotes/${quote.id}/convert`, { token: A.token });
  assert.equal(r.status, 201, r.raw);
  const inv = (await c('GET', `/invoices/${r.body.data.invoiceId}`, { token: A.token })).body.data;
  assert.equal(inv.status, 'draft'); assert.equal(inv.totalTtc, r.body.data.quote.totalTtc); assert.equal(inv.quote.number, quote.number); assert.equal(inv.lines.length, 1);
  assert.equal(r.body.data.quote.status, 'converted'); assert.equal(r.body.data.quote.convertedInvoice.id, inv.id);
  assert.equal((await c('POST', `/quotes/${quote.id}/convert`, { token: A.token })).status, 409, 'une seule conversion');
  assert.equal((await c('PUT', `/quotes/${quote.id}`, { token: A.token, body: { clientId: client.id, issueDate: today, lines: [line({ unitPrice: 1, taxRateId: tax19.id })] } })).status, 409, 'montants verrouillés');
  assert.equal((await c('DELETE', `/quotes/${quote.id}`, { token: A.token })).status, 409);
});

test('duplication de devis : nouveau brouillon, mêmes lignes', async () => {
  const r = await c('POST', `/quotes/${quote.id}/duplicate`, { token: A.token });
  assert.equal(r.status, 201, r.raw);
  assert.notEqual(r.body.data.number, quote.number); assert.equal(r.body.data.status, 'draft'); assert.equal(r.body.data.totalHt, '200.000');
});

test('historique, liste, filtres et PDF', async () => {
  const h = await c('GET', `/invoices/${invoice.id}/history`, { token: A.token });
  assert.ok(h.body.data.some((e) => e.action === 'invoice.issue')); assert.ok(h.body.data.some((e) => e.action === 'invoice.create'));
  const l = await c('GET', '/invoices?status=issued&limit=2', { token: A.token });
  assert.equal(l.body.data.length, 2); assert.ok(l.body.meta.total >= 6);
  assert.equal((await c('GET', '/invoices?paymentStatus=paid', { token: A.token })).body.data.some((i) => i.id === invoice.id), true);
  assert.equal((await c('GET', '/invoices?paymentStatus=unpaid', { token: A.token })).body.data.every((i) => i.status === 'issued'), true);
  assert.equal((await c('GET', `/invoices?q=${invoice.number}`, { token: A.token })).body.data.length, 1);
  assert.equal((await c('GET', '/invoices', { token: B.token })).body.data.every((i) => i.clientName === 'Client B'), true, 'isolation');
  for (const path of [`/invoices/${invoice.id}/pdf`, `/quotes/${quote.id}/pdf`, `/credit-notes/${cn.id}/pdf`]) {
    const res = await fetch(`${app.base}${path}`, { headers: { authorization: `Bearer ${A.token}` } });
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200, path); assert.equal(res.headers.get('content-type'), 'application/pdf'); assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.ok(buf.length > 1500);
  }
});

test('PDF : modèle unique en français, réglage enregistré, arabe refusé, valeur inconnue ignorée', async () => {
  const list = (await c('GET', '/invoices', { token: A.token })).body.data; const inv = list.find((i) => i.status === 'issued');
  const sizes = new Set();
  for (const lang of ['fr', 'ar']) { // `lang` est ignoré : le rendu est identique (français)
    const res = await fetch(`${app.base}/invoices/${inv.id}/pdf?lang=${lang}`, { headers: { authorization: `Bearer ${A.token}` } });
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200); assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); sizes.add(buf.length);
  }
  assert.equal(sizes.size, 1, 'un seul rendu : français uniquement');
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { pdfLanguage: 'ar' } } })).status, 400, 'langue arabe refusée');
  const up = await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { template: 'modern' } } });
  assert.equal(up.status, 200, up.raw);
  const st = (await c('GET', '/companies/current/settings', { token: A.token })).body.data;
  assert.equal(st.branding.template, 'modern'); assert.equal(st.branding.pdfLanguage, 'fr');
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { template: 'evil' } } })).status, 400);
  const bad = await fetch(`${app.base}/invoices/${inv.id}/pdf?template=zzz&lang=xx`, { headers: { authorization: `Bearer ${A.token}` } });
  assert.equal(bad.status, 200);
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { template: 'classic', pdfLanguage: 'fr' } } });
});

test('aperçu serveur : mêmes totaux que la création, sans rien écrire', async () => {
  const body = invBody({ globalDiscountPct: 10, lines: [line({ taxRateId: tax19.id }), { productId: product.id, quantity: 1 }] });
  const before = (await c('GET', '/invoices', { token: A.token })).body.meta.total;
  const pv = await c('POST', '/sales/preview', { token: A.token, body });
  assert.equal(pv.status, 200, pv.raw);
  assert.equal((await c('GET', '/invoices', { token: A.token })).body.meta.total, before);
  const real = (await c('POST', '/invoices', { token: A.token, body })).body.data;
  assert.equal(pv.body.data.totalTtc, real.totalTtc); assert.equal(pv.body.data.lines[1].description, 'Clavier');
  assert.equal((await c('POST', '/sales/preview', { token: readOnly.token, body })).status, 403);
});

test('conditions générales par défaut appliquées', async () => {
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { sales: { defaultTerms: 'Paiement à 30 jours.' } } });
  const d = (await c('POST', '/invoices', { token: A.token, body: invBody() })).body.data;
  assert.equal(d.terms, 'Paiement à 30 jours.');
  assert.equal((await c('POST', '/invoices', { token: A.token, body: invBody({ terms: 'Autre' }) })).body.data.terms, 'Autre');
});
