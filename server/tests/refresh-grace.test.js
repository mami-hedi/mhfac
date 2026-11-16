import test from 'node:test';
import assert from 'node:assert/strict';

// Ce fichier tourne dans son propre processus : on active la fenetre de grace avant d'importer l'application.
process.env.REFRESH_REUSE_GRACE_SECONDS = '2';
const { startApp, registerCompany } = await import('./helpers.js');

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

test('deux refresh simultanes avec le meme cookie (deux onglets) ne deconnectent personne', async () => {
  const o = await registerCompany(app.call);
  const [a, b] = await Promise.all([
    app.call('POST', '/auth/refresh', { cookie: o.cookie }),
    app.call('POST', '/auth/refresh', { cookie: o.cookie }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 200]);
  assert.equal((await app.call('POST', '/auth/refresh', { cookie: a.cookie })).status, 200);
});

test('apres la fenetre de grace, le rejeu d un ancien jeton revoque la famille', async () => {
  const o = await registerCompany(app.call);
  const r1 = await app.call('POST', '/auth/refresh', { cookie: o.cookie });
  assert.equal(r1.status, 200);
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal((await app.call('POST', '/auth/refresh', { cookie: o.cookie })).status, 401);
  assert.equal((await app.call('POST', '/auth/refresh', { cookie: r1.cookie })).status, 401);
});
