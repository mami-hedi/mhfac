import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

let server, base;
test.before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
test.after(async () => { server.close(); await pool.end(); });

test('GET /health repond et indique l etat de la base', async () => {
  const res = await fetch(`${base}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.db, 'up');
});

test('route inconnue -> 404 au format d erreur uniforme', async () => {
  const res = await fetch(`${base}/nope`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('en-tetes de securite Helmet presents, pas de x-powered-by', async () => {
  const res = await fetch(`${base}/health`);
  assert.ok(res.headers.get('x-content-type-options'));
  assert.equal(res.headers.get('x-powered-by'), null);
});
