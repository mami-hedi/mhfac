import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember, sentMails } from './helpers.js';

let app, A, B, readOnly, client, tax19;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
async function invoice(body = {}) {
  const d = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: '2026-01-01', dueDate: '2026-01-31', lines: [{ description: 'Prestation', quantity: 1, unitPrice: '100.000', taxRateId: tax19.id }], ...body } }), 201);
  return ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token }));
}
before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Relance A'); B = await registerCompany(app.call, 'Relance B'); readOnly = await addMember(app.call, A, 'read_only');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Retard', email: 'retard@example.com' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
});
after(() => app.close());

test('relances : factures en retard par client, envoi, anti-doublon 24 h, journal, droits, isolation', async () => {
  const late = await invoice(); const paid = await invoice();
  await invoice({ issueDate: '2999-01-01', dueDate: '2999-02-01' }).catch(() => null);
  ok(await c('POST', '/payments', { token: A.token, body: { clientId: client.id, date: '2026-02-01', method: 'cash', allocations: [{ invoiceId: paid.id, amount: '119' }] } }), 201);
  const list = ok(await c('GET', '/reminders/overdue', { token: A.token }));
  assert.equal(list.length, 1); assert.equal(list[0].invoices.length, 1); assert.equal(list[0].invoices[0].number, late.number);
  assert.equal(list[0].totals.TND, '119.000'); assert.ok(list[0].maxDaysLate > 0); assert.equal(list[0].client.email, 'retard@example.com');
  assert.equal(ok(await c('GET', '/reminders/overdue', { token: B.token })).length, 0, 'isolation');
  assert.equal((await c('POST', '/reminders/send', { token: readOnly.token, body: { clientId: client.id, to: 'retard@example.com' } })).status, 403);
  assert.equal((await c('POST', '/reminders/send', { token: A.token, body: { clientId: client.id, to: 'pas-un-email' } })).status, 400);
  assert.equal((await c('POST', '/reminders/send', { token: B.token, body: { clientId: client.id, to: 'x@example.com' } })).body.error.code, 'NOTHING_OVERDUE', 'client d\'une autre entreprise');
  const r = ok(await c('POST', '/reminders/send', { token: A.token, body: { clientId: client.id, to: 'retard@example.com' } }));
  assert.equal(r.invoices, 1);
  const mail = [...sentMails].reverse().find((m) => m.to === 'retard@example.com');
  assert.ok(mail.text.includes(late.number) && mail.text.includes('119,000'), mail.text);
  assert.equal((await c('POST', '/reminders/send', { token: A.token, body: { clientId: client.id, to: 'retard@example.com' } })).body.error.code, 'RECENT_REMINDER');
  ok(await c('POST', '/reminders/send', { token: A.token, body: { clientId: client.id, to: 'retard@example.com', force: true } }));
  assert.equal(ok(await c('GET', '/reminders/history', { token: A.token })).length, 2);
  assert.equal(ok(await c('GET', '/reminders/overdue', { token: A.token }))[0].reminderCount, 2);
  // facture soldée : plus aucune relance possible
  ok(await c('POST', '/payments', { token: A.token, body: { clientId: client.id, date: '2026-02-02', method: 'cash', allocations: [{ invoiceId: late.id, amount: '119' }] } }), 201);
  assert.equal(ok(await c('GET', '/reminders/overdue', { token: A.token })).length, 0);
  assert.equal((await c('POST', '/reminders/send', { token: A.token, body: { clientId: client.id, to: 'retard@example.com', force: true } })).body.error.code, 'NOTHING_OVERDUE');
});
