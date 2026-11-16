import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, readOnly, accountant, client, tax19;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const line = () => [{ description: 'Prestation', quantity: 1, unitPrice: '1000', taxRateId: tax19.id }];
const issued = async (token = A.token) => { const d = ok(await c('POST', '/invoices', { token, body: { clientId: client.id, issueDate: today, lines: line() } }), 201); return ok(await c('POST', `/invoices/${d.id}/issue`, { token })); };

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'EI A'); B = await registerCompany(app.call, 'EI B');
  readOnly = await addMember(app.call, A, 'read_only'); accountant = await addMember(app.call, A, 'accountant');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client EI' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
});
after(() => app.close());

test('préparation idempotente, simulation, historique et verrouillage', async () => {
  const inv = await issued();
  const draft = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: line() } }), 201);
  assert.equal((await c('POST', `/e-invoicing/invoices/${draft.id}/prepare`, { token: A.token })).body.error.code, 'NOT_ISSUED');
  assert.equal((await c('POST', `/e-invoicing/invoices/${inv.id}/prepare`, { token: readOnly.token })).status, 403);
  assert.equal((await c('POST', `/e-invoicing/invoices/${inv.id}/prepare`, { token: B.token })).status, 404, 'isolation');
  const t = ok(await c('POST', `/e-invoicing/invoices/${inv.id}/prepare`, { token: A.token }), 201);
  assert.equal(t.status, 'pending'); assert.equal(t.simulation, true); assert.equal(t.signatureStatus, 'simulated');
  const again = ok(await c('POST', `/e-invoicing/invoices/${inv.id}/prepare`, { token: A.token }), 200);
  assert.equal(again.id, t.id, 'une seule transmission par facture');
  assert.equal((await c('GET', `/e-invoicing/transmissions/${t.id}`, { token: B.token })).status, 404);
  assert.equal((await c('POST', `/e-invoicing/transmissions/${t.id}/submit`, { token: readOnly.token })).status, 403);
  const s = ok(await c('POST', `/e-invoicing/transmissions/${t.id}/submit`, { token: A.token }));
  assert.equal(s.status, 'accepted'); assert.match(s.providerReference, /^SIM-/);
  assert.equal((await c('POST', `/e-invoicing/transmissions/${t.id}/submit`, { token: A.token })).body.error.code, 'INVALID_TRANSITION');
  const det = ok(await c('GET', `/e-invoicing/transmissions/${t.id}`, { token: A.token }));
  assert.match(det.notice, /SIMULATION/); assert.equal(det.payload.totals.totalTtc, '1190.000'); assert.ok(det.events.length >= 4);
  assert.equal((await c('POST', `/invoices/${inv.id}/cancel`, { token: A.token, body: { reason: 'Annulation de test' } })).body.error.code, 'EINVOICE_TRANSMITTED');
});

test('rejet puis erreur réseau avec nouvelles tentatives (même référence idempotente)', async () => {
  const put = async (scenario) => ok(await c('PUT', '/e-invoicing/config', { token: A.token, body: { scenario } }));
  await put('reject'); const i1 = await issued(); const t1 = ok(await c('POST', `/e-invoicing/invoices/${i1.id}/prepare`, { token: A.token }), 201);
  const r = ok(await c('POST', `/e-invoicing/transmissions/${t1.id}/submit`, { token: A.token })); assert.equal(r.status, 'rejected'); assert.ok(r.lastError);
  await put('network_error'); const i2 = await issued(); const t2 = ok(await c('POST', `/e-invoicing/invoices/${i2.id}/prepare`, { token: A.token }), 201);
  const e = ok(await c('POST', `/e-invoicing/transmissions/${t2.id}/submit`, { token: A.token })); assert.equal(e.status, 'retry'); assert.equal(e.attempts, 1); assert.ok(e.nextRetryAt);
  assert.deepEqual(ok(await c('POST', '/e-invoicing/retry-due', { token: A.token })), [], 'pas encore échu');
  await put('accept'); const ok2 = ok(await c('POST', `/e-invoicing/transmissions/${t2.id}/retry`, { token: A.token }));
  assert.equal(ok2.status, 'accepted'); assert.equal(ok2.attempts, 2);
  const list = await c('GET', '/e-invoicing/transmissions?status=accepted', { token: A.token });
  assert.ok(list.body.meta.byStatus.accepted >= 1); assert.equal(ok(await c('GET', '/e-invoicing/transmissions', { token: B.token })).length, 0);
  assert.equal((await c('PUT', '/e-invoicing/config', { token: accountant.token, body: { scenario: 'accept' } })).status, 200);
  assert.equal((await c('PUT', '/e-invoicing/config', { token: readOnly.token, body: { scenario: 'accept' } })).status, 403);
  assert.equal(ok(await c('GET', '/e-invoicing/config', { token: A.token })).providers.find((p) => p.id === 'ttn').available, false);
});

test('module désactivé (« bientôt disponible ») : toutes les routes répondent 501, authentification toujours exigée', async () => {
  const { env } = await import('../src/config/env.js');
  const prev = env.EINVOICE_MODULE; env.EINVOICE_MODULE = 'off';
  try {
    assert.equal((await c('GET', '/e-invoicing/config', { token: A.token })).status, 501);
    const r = await c('GET', '/e-invoicing', { token: A.token });
    assert.equal(r.status, 501); assert.equal(r.body.error.code, 'MODULE_COMING_SOON');
    assert.equal((await c('GET', '/e-invoicing/config', {})).status, 401, 'sans jeton : 401 avant tout');
  } finally { env.EINVOICE_MODULE = prev; }
  assert.equal((await c('GET', '/e-invoicing/config', { token: A.token })).status, 200, 'réactivable');
});
