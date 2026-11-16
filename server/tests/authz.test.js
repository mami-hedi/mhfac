import test from 'node:test';
import assert from 'node:assert/strict';
import { addMember, lastTokenFor, PASSWORD, registerCompany, startApp, uniqueEmail } from './helpers.js';

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

test('invitation : le comptable accepte, recoit son role, et ne peut pas gerer les utilisateurs ni les parametres', async () => {
  const owner = await registerCompany(app.call);
  const acc = await addMember(app.call, owner, 'accountant');
  const me = await app.call('GET', '/auth/me', { token: acc.token });
  assert.equal(me.body.data.role, 'accountant');
  assert.equal((await app.call('GET', '/users', { token: acc.token })).status, 403);
  assert.equal((await app.call('PATCH', '/companies/current', { token: acc.token, body: { name: 'Pirate' } })).status, 403);
  assert.equal((await app.call('GET', '/companies/current', { token: acc.token })).status, 200, 'lecture de sa propre entreprise autorisee');
});

test('invitation a usage unique, revocable, et visible dans la liste des invitations en attente', async () => {
  const owner = await registerCompany(app.call);
  const email = uniqueEmail('inv');
  const inv = await app.call('POST', '/users/invitations', { token: owner.token, body: { email, roleCode: 'sales' } });
  assert.equal(inv.status, 201);
  assert.equal((await app.call('GET', '/users/invitations', { token: owner.token })).body.data.length, 1);
  const token = lastTokenFor(email, 'token');
  const first = await app.call('POST', '/auth/accept-invitation', { body: { token, fullName: 'Commercial', password: PASSWORD } });
  assert.equal(first.status, 201);
  assert.equal((await app.call('POST', '/auth/accept-invitation', { body: { token, fullName: 'Commercial', password: PASSWORD } })).status, 400);

  const email2 = uniqueEmail('inv2');
  const inv2 = await app.call('POST', '/users/invitations', { token: owner.token, body: { email: email2, roleCode: 'read_only' } });
  assert.equal((await app.call('DELETE', `/users/invitations/${inv2.body.data.id}`, { token: owner.token })).status, 204);
  const t2 = lastTokenFor(email2, 'token');
  assert.equal((await app.call('POST', '/auth/accept-invitation', { body: { token: t2, fullName: 'X Y', password: PASSWORD } })).status, 400);
});

test('delegation : le role proprietaire n est pas attribuable, un admin ne gere pas les admins ni le proprietaire', async () => {
  const owner = await registerCompany(app.call);
  const admin = await addMember(app.call, owner, 'admin');
  const sales = await addMember(app.call, owner, 'sales');
  assert.equal((await app.call('POST', '/users/invitations', { token: owner.token, body: { email: uniqueEmail(), roleCode: 'owner' } })).status, 422);
  assert.equal((await app.call('POST', '/users/invitations', { token: admin.token, body: { email: uniqueEmail(), roleCode: 'admin' } })).status, 403);
  assert.equal((await app.call('PATCH', `/users/${owner.userId}/role`, { token: admin.token, body: { roleCode: 'read_only' } })).status, 403);
  assert.equal((await app.call('PATCH', `/users/${admin.userId}/role`, { token: owner.token, body: { roleCode: 'owner' } })).status, 422);
  assert.equal((await app.call('PATCH', `/users/${owner.userId}/role`, { token: owner.token, body: { roleCode: 'admin' } })).status, 422, 'pas de changement de son propre role');
  assert.equal((await app.call('PATCH', `/users/${sales.userId}/role`, { token: admin.token, body: { roleCode: 'accountant' } })).status, 204);
  const members = (await app.call('GET', '/users', { token: admin.token })).body.data;
  assert.equal(members.find((m) => m.id === sales.userId).role, 'accountant');
});

test('desactivation d un membre : acces coupe immediatement et sessions revoquees', async () => {
  const owner = await registerCompany(app.call);
  const stock = await addMember(app.call, owner, 'stock_manager');
  assert.equal((await app.call('GET', '/companies/current', { token: stock.token })).status, 200);
  assert.equal((await app.call('PATCH', `/users/${stock.userId}/status`, { token: owner.token, body: { status: 'disabled' } })).status, 204);
  const after = await app.call('GET', '/companies/current', { token: stock.token });
  assert.equal(after.status, 403);
  assert.equal(after.body.error.code, 'ACCOUNT_DISABLED');
  assert.equal((await app.call('POST', '/auth/refresh', { cookie: stock.cookie })).status, 401);
  assert.equal((await app.call('PATCH', `/users/${stock.userId}/status`, { token: owner.token, body: { status: 'active' } })).status, 204);
  assert.equal((await app.call('GET', '/companies/current', { token: stock.token })).status, 200);
});

test('le proprietaire modifie son entreprise ; le journal d audit garde la trace', async () => {
  const owner = await registerCompany(app.call);
  const r = await app.call('PATCH', '/companies/current', { token: owner.token, body: { name: 'Nouvelle Raison Sociale', taxId: '9999999/Z' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'Nouvelle Raison Sociale');
  assert.equal((await app.call('PATCH', '/companies/current', { token: owner.token, body: {} })).status, 400);
  const { pool } = await import('../src/config/db.js');
  const [[row]] = await pool.query('SELECT COUNT(*) n FROM audit_logs a JOIN companies c ON c.id = a.company_id WHERE c.public_id = ? AND a.action IN (?, ?)', [owner.companyId, 'company.registered', 'company.updated']);
  assert.equal(Number(row.n), 2);
});
