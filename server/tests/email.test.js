import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember, sentMails } from './helpers.js';
import { env } from '../src/config/env.js';

let app, A, B, readOnly, client, tax19;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const body = () => ({ clientId: client.id, issueDate: today, lines: [{ description: 'Prestation', quantity: 1, unitPrice: '100', taxRateId: tax19.id }] });

before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Alpha'); B = await registerCompany(app.call, 'Beta');
  readOnly = await addMember(app.call, A, 'read_only');
  client = (await c('POST', '/clients', { token: A.token, body: { name: 'Client Mail', email: 'client@exemple.tn' } })).body.data;
  tax19 = (await c('GET', '/tax-rates', { token: A.token })).body.data.find((t) => t.rate === '19.00');
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { identity: { email: 'contact@alpha.tn' } } });
});
after(() => app.close());

test('facture émise : e-mail avec PDF joint, réponse à l\'adresse de l\'entreprise, historique', async () => {
  const d = (await c('POST', '/invoices', { token: A.token, body: body() })).body.data;
  const issued = (await c('POST', `/invoices/${d.id}/issue`, { token: A.token })).body.data;
  const before = sentMails.length;
  const r = await c('POST', `/invoices/${issued.id}/send`, { token: A.token, body: { to: ['Client@Exemple.tn', 'compta@exemple.tn'], message: 'Merci de votre confiance.' } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(sentMails.length, before + 1);
  const m = sentMails.at(-1);
  assert.equal(m.to, 'client@exemple.tn, compta@exemple.tn');
  assert.equal(m.attachments[0].filename, `${issued.number}.pdf`); assert.ok(m.attachments[0].size > 1000);
  assert.equal(m.replyTo, 'contact@alpha.tn');
  assert.match(m.subject, new RegExp(issued.number)); assert.match(m.text, /Merci de votre confiance/);
  const h = await c('GET', `/invoices/${issued.id}/emails`, { token: A.token });
  assert.equal(h.body.data.length, 1); assert.equal(h.body.data[0].status, 'sent');
});

test('refus : brouillon, adresse invalide, injection d\'en-tête, trop de destinataires, droits, isolation', async () => {
  const d = (await c('POST', '/invoices', { token: A.token, body: body() })).body.data;
  assert.equal((await c('POST', `/invoices/${d.id}/send`, { token: A.token, body: { to: 'a@b.tn' } })).status, 409);
  const issued = (await c('POST', `/invoices/${d.id}/issue`, { token: A.token })).body.data;
  assert.equal((await c('POST', `/invoices/${issued.id}/send`, { token: A.token, body: { to: 'pas-un-mail' } })).status, 400);
  assert.equal((await c('POST', `/invoices/${issued.id}/send`, { token: A.token, body: { to: 'a@b.tn\r\nBcc: evil@x.tn' } })).status, 400);
  assert.equal((await c('POST', `/invoices/${issued.id}/send`, { token: A.token, body: { to: [] } })).status, 400);
  assert.equal((await c('POST', `/invoices/${issued.id}/send`, { token: A.token, body: { to: Array.from({ length: 6 }, (_, i) => `u${i}@x.tn`) } })).status, 400);
  assert.equal((await c('POST', `/invoices/${issued.id}/send`, { token: readOnly.token, body: { to: 'a@b.tn' } })).status, 403);
  assert.equal((await c('POST', `/invoices/${issued.id}/send`, { token: B.token, body: { to: 'a@b.tn' } })).status, 404);
  const r = await c('POST', `/invoices/${issued.id}/send`, { token: A.token, body: { to: 'a@b.tn', subject: 'Ligne1\r\nBcc: evil@x.tn' } });
  assert.equal(r.status, 200); assert.ok(!sentMails.at(-1).subject.includes('\n'));
  await c('POST', `/invoices/${issued.id}/cancel`, { token: A.token, body: { reason: 'Annulée pour test' } });
  assert.equal((await c('POST', `/invoices/${issued.id}/send`, { token: A.token, body: { to: 'a@b.tn' } })).status, 409);
});

test('devis brouillon envoyé par e-mail -> statut « envoyé »', async () => {
  const q = (await c('POST', '/quotes', { token: A.token, body: body() })).body.data;
  const r = await c('POST', `/quotes/${q.id}/send`, { token: A.token, body: { to: 'client@exemple.tn' } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.data.doc.storedStatus, 'sent');
  assert.match(sentMails.at(-1).subject, /^Devis DEV-/);
  const h = await c('GET', `/quotes/${q.id}/history`, { token: A.token });
  assert.ok(h.body.data.some((x) => x.action === 'quote.sent'));
});

test('échec SMTP : tentative journalisée, erreur claire, pas de passage « envoyé »', async () => {
  const q = (await c('POST', '/quotes', { token: A.token, body: body() })).body.data;
  const saved = { p: env.MAIL_PROVIDER, h: env.SMTP_HOST, port: env.SMTP_PORT };
  env.MAIL_PROVIDER = 'smtp'; env.SMTP_HOST = '127.0.0.1'; env.SMTP_PORT = 1;
  try {
    const r = await c('POST', `/quotes/${q.id}/send`, { token: A.token, body: { to: 'client@exemple.tn' } });
    assert.equal(r.status, 502); assert.equal(r.body.error.code, 'MAIL_FAILED');
  } finally { env.MAIL_PROVIDER = saved.p; env.SMTP_HOST = saved.h; env.SMTP_PORT = saved.port; }
  assert.equal((await c('GET', `/quotes/${q.id}`, { token: A.token })).body.data.storedStatus, 'draft');
  const h = await c('GET', `/quotes/${q.id}/emails`, { token: A.token });
  assert.equal(h.body.data[0].status, 'failed');
});
