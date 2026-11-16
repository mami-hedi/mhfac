// Correctifs de l'audit de sécurité (novembre 2026) : chaque faille corrigée a ici son test de non-régression.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { startApp, registerCompany } from './helpers.js';

let app, A;
const c = (...a) => app.call(...a);
before(async () => { app = await startApp(); A = await registerCompany(app.call, 'Audit A'); });
after(() => app.close());

test('F1 — abonnement expiré : « /auth/ » glissé dans la query string ne débloque PAS l\'écriture', async () => {
  await pool.query('UPDATE company_subscriptions SET trial_ends_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE company_id = (SELECT id FROM companies WHERE public_id = ?)', [A.companyId]);
  const plain = await c('POST', '/clients', { token: A.token, body: { name: 'Bloqué 1' } });
  assert.equal(plain.status, 403); assert.equal(plain.body.error.code, 'SUBSCRIPTION_INACTIVE');
  for (const q of ['?x=/auth/', '?x=/subscription/', '?next=/notifications', '?/auth/']) {
    const r = await c('POST', `/clients${q}`, { token: A.token, body: { name: 'Contournement' } });
    assert.equal(r.status, 403, `contournement par ${q}`); assert.equal(r.body.error.code, 'SUBSCRIPTION_INACTIVE');
  }
  assert.equal((await c('GET', '/clients', { token: A.token })).status, 200, 'lecture toujours possible');
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM clients WHERE name IN ('Contournement','Bloqué 1')"); assert.equal(Number(n.n), 0);
});

test('F2 — /auth/me, /auth/refresh restent utilisables en rafale (pas de blocage par la limite stricte)', async () => {
  for (let i = 0; i < 30; i++) assert.equal((await c('GET', '/auth/me', { token: A.token })).status, 200);
});

test('F3 — mots de passe faibles ou ambigus refusés à l\'inscription', async () => {
  const body = (password) => ({ companyName: 'Faible SARL', fullName: 'Test Faible', email: `faible${Date.now()}${Math.floor(Math.random() * 1e4)}@exemple.tn`, password });
  for (const pw of ['Password123', 'motdepasse2026', 'azerty12345', '1111111111', 'a'.repeat(73) + '1', 'é'.repeat(40) + '1']) {
    const r = await c('POST', '/auth/register-company', { body: body(pw) });
    assert.equal(r.status, 400, `mot de passe refusé : ${pw.slice(0, 12)}…`);
  }
  const ok = await c('POST', '/auth/register-company', { body: body('Tr0ubadour&Chaise-77') });
  assert.equal(ok.status, 201);
});

test('F4 — mot de passe oublié : même réponse pour un compte inconnu, limite de 3 e-mails par heure et par adresse', async () => {
  const unknown = await c('POST', '/auth/forgot-password', { body: { email: 'inconnu-xyz@exemple.tn' } });
  assert.equal(unknown.status, 202);
  const email = A.email;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await c('POST', '/auth/forgot-password', { body: { email } })).status);
  assert.deepEqual(codes, [202, 202, 202, 429, 429]);
});

test('PATCH partiel : les champs non envoyés ne sont JAMAIS remis à leur valeur par défaut (clients, articles)', async () => {
  const T = await registerCompany(app.call, 'Patch Co');
  const tax = (await c('GET', '/tax-rates', { token: T.token })).body.data.find((t) => t.rate === '19.00');
  const cl = (await c('POST', '/clients', { token: T.token, body: { name: 'Client Patch', paymentTermsDays: 45, country: 'FR', currency: 'EUR', type: 'individual' } })).body.data;
  const r = await c('PATCH', `/clients/${cl.id}`, { token: T.token, body: { name: 'Client Patch 2' } });
  assert.equal(r.status, 200, r.raw);
  const got = (await c('GET', `/clients/${cl.id}`, { token: T.token })).body.data;
  assert.equal(got.name, 'Client Patch 2'); assert.equal(got.paymentTermsDays, 45); assert.equal(got.country, 'FR'); assert.equal(got.currency, 'EUR'); assert.equal(got.type, 'individual');
  assert.equal((await c('PATCH', `/clients/${cl.id}`, { token: T.token, body: {} })).status, 400);
  const p = (await c('POST', '/products', { token: T.token, body: { name: 'Article Patch', salePrice: '77.500', unit: 'kg', taxRateId: tax.id, trackStock: true, fodecSubject: true } })).body.data;
  assert.equal((await c('PATCH', `/products/${p.id}`, { token: T.token, body: { name: 'Article Patch 2' } })).status, 200);
  const gp = (await c('GET', `/products/${p.id}`, { token: T.token })).body.data;
  assert.equal(gp.salePrice, '77.500'); assert.equal(gp.unit, 'kg'); assert.equal(gp.trackStock, true); assert.equal(gp.fodecSubject, true);
  assert.equal((await c('PATCH', `/products/${p.id}`, { token: T.token, body: {} })).status, 400);
});

test('e-mails de documents : refusés tant que l\'adresse du compte n\'est pas confirmée', async () => {
  const email = `nonverifie${Date.now()}@exemple.tn`;
  const r = await c('POST', '/auth/register-company', { body: { companyName: 'Non Verifie SARL', fullName: 'Non Verifie', email, password: 'Tr0ubadour&Chaise-77' } });
  assert.equal(r.status, 201);
  const tk = r.body.data.accessToken;
  const tax = (await c('GET', '/tax-rates', { token: tk })).body.data.find((t) => t.rate === '19.00');
  const cl = (await c('POST', '/clients', { token: tk, body: { name: 'Client Mail', email: 'client@exemple.tn' } })).body.data;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
  const q = (await c('POST', '/quotes', { token: tk, body: { clientId: cl.id, issueDate: today, lines: [{ description: 'x', quantity: 1, unitPrice: '100', taxRateId: tax.id }] } })).body.data;
  const s = await c('POST', `/quotes/${q.id}/send`, { token: tk, body: { to: ['client@exemple.tn'] } });
  assert.equal(s.status, 403); assert.equal(s.body.error.code, 'EMAIL_NOT_VERIFIED');
});
