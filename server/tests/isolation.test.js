import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { signAccessToken } from '../src/core/tokens.js';
import { addMember, lastTokenFor, PASSWORD, registerCompany, startApp, uniqueEmail } from './helpers.js';

let app, A, B, bSales;
test.before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Entreprise A');
  B = await registerCompany(app.call, 'Entreprise B');
  bSales = await addMember(app.call, B, 'sales');
});
test.after(() => app.close());

test('la liste des utilisateurs ne contient que les membres de l entreprise du jeton', async () => {
  const a = (await app.call('GET', '/users', { token: A.token })).body.data;
  const ids = a.map((m) => m.id);
  assert.ok(ids.includes(A.userId));
  assert.ok(!ids.includes(B.userId) && !ids.includes(bSales.userId));
  const b = (await app.call('GET', '/users', { token: B.token })).body.data;
  assert.equal(b.length, 2);
});

test('IDOR : agir sur un utilisateur ou une invitation d une autre entreprise donne 404', async () => {
  assert.equal((await app.call('PATCH', `/users/${bSales.userId}/role`, { token: A.token, body: { roleCode: 'read_only' } })).status, 404);
  assert.equal((await app.call('PATCH', `/users/${bSales.userId}/status`, { token: A.token, body: { status: 'disabled' } })).status, 404);

  const inv = await app.call('POST', '/users/invitations', { token: B.token, body: { email: uniqueEmail(), roleCode: 'read_only' } });
  assert.equal((await app.call('DELETE', `/users/invitations/${inv.body.data.id}`, { token: A.token })).status, 404);
  assert.equal((await app.call('GET', '/users/invitations', { token: A.token })).body.data.length, 0);
  // et B n'a pas ete modifie
  const still = (await app.call('GET', '/users', { token: B.token })).body.data.find((m) => m.id === bSales.userId);
  assert.equal(still.role, 'sales');
  assert.equal(still.status, 'active');
});

test('l entreprise vient du jeton : en-tete, query et corps envoyes par le client sont ignores', async () => {
  const r = await app.call('GET', `/companies/current?companyId=${B.companyId}`, {
    token: A.token, headers: { 'x-company-id': B.companyId },
  });
  assert.equal(r.body.data.id, A.companyId);
  const patch = await app.call('PATCH', '/companies/current', { token: A.token, body: { name: 'Renomme par A' }, headers: { 'x-company-id': B.companyId } });
  assert.equal(patch.status, 200);
  const b = await app.call('GET', '/companies/current', { token: B.token });
  assert.notEqual(b.body.data.name, 'Renomme par A');
});

test('un jeton valide mais pointant vers une entreprise dont l utilisateur n est pas membre est refuse', async () => {
  const [[a]] = await pool.query('SELECT id FROM users WHERE public_id = ?', [A.userId]);
  const [[b]] = await pool.query('SELECT id FROM companies WHERE public_id = ?', [B.companyId]);
  const forged = signAccessToken({ userId: a.id, companyId: b.id }); // signature correcte, appartenance fausse
  assert.equal((await app.call('GET', '/users', { token: forged })).status, 401);
});

test('utilisateur multi-entreprises : roles distincts par entreprise, bascule via switch-company', async () => {
  // Le proprietaire de A rejoint B comme comptable avec son compte existant.
  const inv = await app.call('POST', '/users/invitations', { token: B.token, body: { email: A.email, roleCode: 'accountant' } });
  assert.equal(inv.status, 201);
  const bad = await app.call('POST', '/auth/accept-invitation', { body: { token: lastTokenFor(A.email, 'token'), password: 'Faux123456789' } });
  assert.equal(bad.status, 401, 'compte existant : le mot de passe est exige');
  const acc = await app.call('POST', '/auth/accept-invitation', { body: { token: lastTokenFor(A.email, 'token'), password: PASSWORD } });
  assert.equal(acc.status, 201);
  assert.equal(acc.body.data.company.id, B.companyId);
  assert.equal(acc.body.data.role, 'accountant');

  const inB = await app.call('GET', '/auth/me', { token: acc.body.data.accessToken });
  assert.equal(inB.body.data.memberships.length, 2);
  assert.equal((await app.call('GET', '/users', { token: acc.body.data.accessToken })).status, 403, 'comptable dans B');

  const sw = await app.call('POST', '/auth/switch-company', { token: acc.body.data.accessToken, cookie: acc.cookie, body: { companyId: A.companyId } });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.data.role, 'owner');
  assert.equal((await app.call('GET', '/users', { token: sw.body.data.accessToken })).status, 200, 'proprietaire dans A');
  assert.equal((await app.call('POST', '/auth/refresh', { cookie: acc.cookie })).status, 401, 'ancienne session revoquee par la bascule');

  // Bascule vers une entreprise dont on n'est pas membre
  const C = await registerCompany(app.call, 'Entreprise C');
  assert.equal((await app.call('POST', '/auth/switch-company', { token: sw.body.data.accessToken, body: { companyId: C.companyId } })).status, 404);
});
