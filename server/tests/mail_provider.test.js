import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, sentMails, uniqueEmail, PASSWORD } from './helpers.js';
import { sendMail } from '../src/core/mailer.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

async function withResend(fakeFetch, fn) {
  const saved = { p: env.MAIL_PROVIDER, k: env.RESEND_API_KEY, f: globalThis.fetch, from: env.MAIL_FROM };
  Object.assign(env, { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', MAIL_FROM: 'MHFac <no-reply@exemple.tn>' });
  globalThis.fetch = (url, init) => (String(url).startsWith('https://api.resend.com') ? fakeFetch(url, init) : saved.f(url, init)); // seul Resend est simulé : le client de test continue d'appeler l'API locale
  try { return await fn(); } finally { Object.assign(env, { MAIL_PROVIDER: saved.p, RESEND_API_KEY: saved.k, MAIL_FROM: saved.from }); globalThis.fetch = saved.f; }
}

test('Resend : appel HTTPS correct (clé en en-tête, destinataires séparés, pièce jointe en base64)', async () => {
  let seen;
  await withResend(async (url, init) => { seen = { url, init }; return new Response('{"id":"x"}', { status: 200 }); }, () =>
    sendMail({ to: 'a@x.tn, b@x.tn', subject: 'Test', text: 'Bonjour', replyTo: 'r@x.tn', attachments: [{ filename: 'f.pdf', content: Buffer.from('PDF') }] }));
  assert.equal(seen.url, 'https://api.resend.com/emails');
  assert.equal(seen.init.headers.authorization, 'Bearer re_test_key');
  const b = JSON.parse(seen.init.body);
  assert.deepEqual(b.to, ['a@x.tn', 'b@x.tn']); assert.equal(b.reply_to, 'r@x.tn');
  assert.equal(b.attachments[0].content, Buffer.from('PDF').toString('base64'));
});

test('Resend : refus du fournisseur = erreur sans fuite de la clé', async () => {
  await withResend(async () => new Response('{"message":"domain not verified"}', { status: 403 }), async () => {
    await assert.rejects(() => sendMail({ to: 'a@x.tn', subject: 'T', text: 't' }), (e) => /HTTP 403/.test(e.message) && !e.message.includes('re_test_key'));
  });
});

test('inscription réussie même si le fournisseur d\'e-mail est en panne ; renvoi possible ensuite', async () => {
  const email = uniqueEmail('reg');
  const r = await withResend(async () => { throw new Error('réseau coupé'); }, () =>
    app.call('POST', '/auth/register-company', { body: { companyName: 'Panne SARL', fullName: 'Test Panne', email, password: PASSWORD } }));
  assert.equal(r.status, 201, r.raw);
  const token = r.body.data.accessToken;
  const before = sentMails.length;
  const again = await app.call('POST', '/auth/resend-verification', { token });
  assert.equal(again.status, 200, again.raw);
  assert.equal(again.body.data.alreadyVerified, false);
  assert.equal(sentMails.length, before + 1);
  assert.match(sentMails.at(-1).text, /verify-email\?token=/);
});

test('renvoi : refusé sans connexion, sans objet si déjà vérifié, limité à 3 par heure', async () => {
  assert.equal((await app.call('POST', '/auth/resend-verification')).status, 401);
  const o = await registerCompany(app.call, 'Verifiee');
  const v = await app.call('POST', '/auth/resend-verification', { token: o.token });
  assert.equal(v.body.data.alreadyVerified, true); // l'aide de test confirme l'adresse
  await pool.query('UPDATE users SET email_verified_at = NULL WHERE public_id = ?', [o.userId]);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await app.call('POST', '/auth/resend-verification', { token: o.token })).status);
  assert.deepEqual(codes.slice(-1), [429]);
});
