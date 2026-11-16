import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { PASSWORD, lastTokenFor, registerCompany, startApp, uniqueEmail } from './helpers.js';

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

test('inscription : cree entreprise + proprietaire, cookie httpOnly/SameSite=Strict, jamais de hash dans la reponse', async () => {
  const email = uniqueEmail('reg');
  const r = await app.call('POST', '/auth/register-company', { body: { companyName: 'ACME SARL', taxId: '1234567/A', fullName: 'Ali Ben', email, password: PASSWORD } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.role, 'owner');
  assert.ok(r.body.data.accessToken);
  assert.equal(r.body.data.refreshToken, undefined, 'le jeton de rafraichissement ne doit pas etre dans le corps');
  assert.match(r.setCookie, /HttpOnly/i);
  assert.match(r.setCookie, /SameSite=Strict/i);
  assert.match(r.setCookie, /Path=\/api\/v1\/auth/);
  assert.ok(!/password|hash/i.test(r.raw));
});

test('inscription : e-mail deja utilise -> 409, mot de passe faible -> 400', async () => {
  const o = await registerCompany(app.call);
  const dup = await app.call('POST', '/auth/register-company', { body: { companyName: 'X Y', fullName: 'Dup', email: o.email, password: PASSWORD } });
  assert.equal(dup.status, 409);
  const weak = await app.call('POST', '/auth/register-company', { body: { companyName: 'X Y', fullName: 'Weak', email: uniqueEmail(), password: 'court' } });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.code, 'VALIDATION_ERROR');
});

test('connexion : meme erreur pour mauvais mot de passe et e-mail inconnu', async () => {
  const o = await registerCompany(app.call);
  const bad = await app.call('POST', '/auth/login', { body: { email: o.email, password: 'MauvaisMdp123' } });
  const unknown = await app.call('POST', '/auth/login', { body: { email: uniqueEmail('nobody'), password: 'MauvaisMdp123' } });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(bad.body, unknown.body);
  const ok = await app.call('POST', '/auth/login', { body: { email: o.email, password: PASSWORD } });
  assert.equal(ok.status, 200);
});

test('verrouillage apres 3 echecs (env test) : meme le bon mot de passe est refuse', async () => {
  const o = await registerCompany(app.call);
  for (let i = 0; i < 3; i++) await app.call('POST', '/auth/login', { body: { email: o.email, password: 'MauvaisMdp123' } });
  const locked = await app.call('POST', '/auth/login', { body: { email: o.email, password: PASSWORD } });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
});

test('routes protegees : sans jeton 401, jeton falsifie 401', async () => {
  assert.equal((await app.call('GET', '/auth/me')).status, 401);
  const o = await registerCompany(app.call);
  const forged = o.token.slice(0, -4) + 'AAAA';
  assert.equal((await app.call('GET', '/auth/me', { token: forged })).status, 401);
  const me = await app.call('GET', '/auth/me', { token: o.token });
  assert.equal(me.status, 200);
  assert.ok(me.body.data.permissions.includes('invoice.validate'));
  assert.equal(me.body.data.memberships.length, 1);
});

test('refresh : rotation, et reutilisation d un ancien jeton revoque toute la famille', async () => {
  const o = await registerCompany(app.call);
  const r1 = await app.call('POST', '/auth/refresh', { cookie: o.cookie });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.cookie, o.cookie);
  assert.ok(r1.body.data.accessToken);

  const replay = await app.call('POST', '/auth/refresh', { cookie: o.cookie }); // ancien jeton rejoue
  assert.equal(replay.status, 401);
  const afterTheft = await app.call('POST', '/auth/refresh', { cookie: r1.cookie }); // la famille est revoquee
  assert.equal(afterTheft.status, 401);
});

test('deconnexion : le jeton de rafraichissement ne fonctionne plus', async () => {
  const o = await registerCompany(app.call);
  assert.equal((await app.call('POST', '/auth/logout', { cookie: o.cookie })).status, 204);
  assert.equal((await app.call('POST', '/auth/refresh', { cookie: o.cookie })).status, 401);
  assert.equal((await app.call('POST', '/auth/refresh')).status, 401);
});

test('verification e-mail : le lien envoye marque l adresse comme verifiee, usage unique', async () => {
  const o = await registerCompany(app.call);
  await pool.query('UPDATE users SET email_verified_at = NULL WHERE public_id = ?', [o.userId]); // l'aide de test confirme l'adresse : on repart d'un compte non confirmé
  assert.equal((await app.call('GET', '/auth/me', { token: o.token })).body.data.user.emailVerified, false);
  const token = lastTokenFor(o.email, 'token');
  assert.ok(token);
  assert.equal((await app.call('POST', '/auth/verify-email', { body: { token } })).status, 204);
  assert.equal((await app.call('GET', '/auth/me', { token: o.token })).body.data.user.emailVerified, true);
  assert.equal((await app.call('POST', '/auth/verify-email', { body: { token } })).status, 400);
});

test('mot de passe oublie : reponse identique, reinitialisation, sessions revoquees, lien a usage unique', async () => {
  const o = await registerCompany(app.call);
  const known = await app.call('POST', '/auth/forgot-password', { body: { email: o.email } });
  const unknown = await app.call('POST', '/auth/forgot-password', { body: { email: uniqueEmail('ghost') } });
  assert.equal(known.status, 202);
  assert.deepEqual(known.body, unknown.body);

  const token = lastTokenFor(o.email, 'token');
  const NEW = 'NouveauMdp2027';
  assert.equal((await app.call('POST', '/auth/reset-password', { body: { token, password: NEW } })).status, 204);
  assert.equal((await app.call('POST', '/auth/reset-password', { body: { token, password: NEW } })).status, 400);
  assert.equal((await app.call('POST', '/auth/login', { body: { email: o.email, password: PASSWORD } })).status, 401);
  assert.equal((await app.call('POST', '/auth/login', { body: { email: o.email, password: NEW } })).status, 200);
  assert.equal((await app.call('POST', '/auth/refresh', { cookie: o.cookie })).status, 401, 'anciennes sessions revoquees');
});

test('changement de mot de passe : exige l ancien et revoque les sessions', async () => {
  const o = await registerCompany(app.call);
  const wrong = await app.call('POST', '/auth/change-password', { token: o.token, body: { currentPassword: 'Faux123456789', newPassword: 'Autre2027Mdp' } });
  assert.equal(wrong.status, 400);
  const ok = await app.call('POST', '/auth/change-password', { token: o.token, body: { currentPassword: PASSWORD, newPassword: 'Autre2027Mdp' } });
  assert.equal(ok.status, 204);
  assert.equal((await app.call('POST', '/auth/refresh', { cookie: o.cookie })).status, 401);
});
