import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { startApp, registerCompany, addMember } from './helpers.js';
import { listRoutes } from './helpers_routes.js';

let app, A, B, readOnly, routes;
const c = (...a) => app.call(...a);
const PUBLIC = new Set(['GET /api/v1/public/plans', 'GET /api/v1/health', 'GET /api/v1/health/', 'POST /api/v1/auth/register-company', 'POST /api/v1/auth/login', 'POST /api/v1/auth/refresh', 'POST /api/v1/auth/logout', 'POST /api/v1/auth/forgot-password', 'POST /api/v1/auth/reset-password',
  'POST /api/v1/auth/verify-email', 'POST /api/v1/auth/accept-invitation', 'GET /api/v1/auth/invitation', 'POST /api/v1/auth/resend-verification', 'POST /api/v1/auth/switch-company']);
const fill = (path, id) => path.replace(/:[A-Za-z]+/g, id);
const UUID0 = '00000000-0000-4000-8000-000000000000';
const rel = (r) => r.path.replace('/api/v1', '');

before(async () => {
  app = await startApp(); routes = listRoutes(createApp());
  A = await registerCompany(app.call, 'Sec A'); B = await registerCompany(app.call, 'Sec B'); readOnly = await addMember(app.call, A, 'read_only');
});
after(() => app.close());

test('inventaire des routes : la découverte fonctionne', () => { assert.ok(routes.length > 250, `routes trouvées : ${routes.length}`); assert.ok(routes.some((r) => r.method === 'POST' && r.path === '/api/v1/invoices/:id/issue')); });

test('AUCUNE route métier n\'est accessible sans authentification (401)', async () => {
  const bad = [];
  for (const r of routes) {
    if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
    const res = await c(r.method, fill(rel(r), UUID0), r.method === 'GET' || r.method === 'DELETE' ? {} : { body: {} });
    if (res.status !== 401) bad.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(bad, [], `routes non protégées :\n${bad.join('\n')}`);
});

test('jeton invalide ou falsifié : 401 partout', async () => {
  for (const token of ['abc', 'Bearer', `${A.token}x`, A.token.split('.').slice(0, 2).join('.') + '.']) {
    const r = await c('GET', '/clients', { token }); assert.equal(r.status, 401);
  }
  const none = await fetch(`${app.base}/clients`, { headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } }); assert.equal(none.status, 401);
});

test('rôle lecture seule : AUCUNE écriture métier possible (403) sur toutes les routes d\'écriture', async () => {
  const bad = [];
  for (const r of routes.filter((x) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(x.method))) {
    if (r.path.startsWith('/api/v1/auth') || r.path.startsWith('/api/v1/platform') || /\/(preview|availability)$/.test(r.path)) continue; // les « preview » ne font que calculer des totaux, sans rien écrire
    if (r.path.startsWith('/api/v1/notifications')) continue; // exception voulue : chacun marque SES notifications comme lues et règle SES préférences (aucune donnée métier ; isolation vérifiée dans notifications.test.js)
    const res = await c(r.method, fill(rel(r), UUID0), { token: readOnly.token, body: {} });
    if (res.status !== 403) bad.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(bad, [], `écritures permises à tort :\n${bad.join('\n')}`);
});

test('espace plateforme : fermé à tout compte non super admin (403) sur toutes les routes', async () => {
  const bad = [];
  for (const r of routes.filter((x) => x.path.startsWith('/api/v1/platform'))) { const res = await c(r.method, fill(rel(r), UUID0), r.method === 'GET' ? { token: A.token } : { token: A.token, body: {} }); if (res.status !== 403) bad.push(`${r.method} ${r.path} -> ${res.status}`); }
  assert.deepEqual(bad, []);
});

test('isolation : aucun GET /:id d\'une autre entreprise ne renvoie 200, et jamais 500', async () => {
  // crée des ressources chez A, puis les lit avec le jeton de B
  const cl = (await c('POST', '/clients', { token: A.token, body: { name: 'Client privé A' } })).body.data;
  const gets = routes.filter((r) => r.method === 'GET' && /:[A-Za-z]+$/.test(r.path) && !r.path.startsWith('/api/v1/platform') && !r.path.startsWith('/api/v1/auth'));
  const bad = [];
  for (const r of gets) {
    for (const id of [cl.id, UUID0, '1', "' OR 1=1 --"]) {
      const res = await c('GET', fill(rel(r), encodeURIComponent(id)), { token: B.token });
      const empty = res.body?.data == null || (Array.isArray(res.body.data) && res.body.data.length === 0);
      if ((res.status === 200 && !empty) || res.status >= 500) bad.push(`GET ${r.path} [${id}] -> ${res.status}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
  assert.equal((await c('GET', `/clients/${cl.id}`, { token: B.token })).status, 404);
  assert.equal((await c('GET', `/clients/${cl.id}`, { token: A.token })).status, 200);
});

test('entrées malveillantes : jamais d\'erreur 500 (injection SQL, XSS, très longues chaînes, types inattendus)', async () => {
  const evil = ["' OR '1'='1", '1; DROP TABLE users; --', '<script>alert(1)</script>', '%', '_', 'a'.repeat(5000), '../../etc/passwd', '\u0000', '{"$ne":null}'];
  const bad = [];
  for (const r of routes.filter((x) => x.method === 'GET' && !/:[A-Za-z]+/.test(x.path) && !x.path.startsWith('/api/v1/platform') && !x.path.startsWith('/api/v1/auth') && !x.path.endsWith('/health'))) {
    for (const v of evil) {
      for (const k of ['q', 'status', 'sort', 'from', 'clientId', 'page', 'limit']) {
        const res = await c('GET', `${rel(r)}?${k}=${encodeURIComponent(v)}`, { token: A.token });
        if (res.status >= 500) bad.push(`GET ${r.path}?${k}=${v.slice(0, 20)} -> ${res.status}`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.slice(0, 15).join('\n'));
  // corps JSON invalide / types inattendus sur les écritures
  for (const body of [{ name: { $gt: '' } }, { name: ['a'] }, { name: 12345 }, { name: null }, { name: 'x'.repeat(100000) }]) {
    const res = await c('POST', '/clients', { token: A.token, body }); assert.ok(res.status === 400 || res.status === 413, `${JSON.stringify(body).slice(0, 40)} -> ${res.status} ${res.raw.slice(0, 150)}`);
  }
  const raw = await fetch(`${app.base}/clients`, { method: 'POST', headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' }, body: '{"name": ' }); assert.equal(raw.status, 400);
  const huge = await fetch(`${app.base}/clients`, { method: 'POST', headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(2_000_000) }) }); assert.equal(huge.status, 413);
});

test('mass assignment : company_id / totaux / statut envoyés par le client sont ignorés', async () => {
  const cl = (await c('POST', '/clients', { token: A.token, body: { name: 'Client MA' } })).body.data;
  const tax = (await c('GET', '/tax-rates', { token: A.token })).body.data.find((t) => t.rate === '19.00');
  const r = await c('POST', '/invoices', { token: A.token, body: { clientId: cl.id, issueDate: new Date().toISOString().slice(0, 10), companyId: B.companyId, company_id: 999, status: 'issued', totalTtc: '1.000', number: 'HACK-1', paidAmount: '999', lines: [{ description: 'X', quantity: 1, unitPrice: '100', taxRateId: tax.id }] } });
  assert.equal(r.status, 201, r.raw); const d = r.body.data; assert.equal(d.status, 'draft'); assert.equal(d.totalTtc, '119.000'); assert.equal(d.number, null); assert.equal(Number(d.paidAmount ?? 0), 0);
  assert.equal((await c('GET', `/invoices/${d.id}`, { token: B.token })).status, 404);
});

test('en-têtes de sécurité, CORS, cookie de session', async () => {
  const r = await fetch(`${app.base}/health`, { headers: { origin: 'http://localhost:5173' } });
  assert.equal(r.headers.get('x-powered-by'), null); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.ok(r.headers.get('strict-transport-security')); assert.ok(r.headers.get('x-frame-options') || r.headers.get('content-security-policy'));
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const evil = await fetch(`${app.base}/health`, { headers: { origin: 'https://evil.example' } }); assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.example');
  const reg = await c('POST', '/auth/login', { body: { email: A.email, password: 'Zebre-Violet-2026' } }); const sc = reg.setCookie.toLowerCase();
  assert.ok(sc.includes('httponly')); assert.ok(sc.includes('samesite=strict')); assert.ok(sc.includes('path=/api/v1/auth')); assert.ok(!JSON.stringify(reg.body).includes(reg.cookie), 'le jeton de rafraîchissement n\'est jamais dans le corps');
});

test('verrouillage après échecs de connexion, sans révéler si le compte existe', async () => {
  const x = await registerCompany(app.call, 'Sec Lock'); let last;
  for (let i = 0; i < 4; i++) last = await c('POST', '/auth/login', { body: { email: x.email, password: 'MauvaisMotDePasse1' } });
  assert.equal((await c('POST', '/auth/login', { body: { email: x.email, password: 'Zebre-Violet-2026' } })).status, 429, 'compte verrouillé même avec le bon mot de passe');
  const unknown = await c('POST', '/auth/login', { body: { email: 'inconnu@nulle.part', password: 'Zebre-Violet-2026x' } }); const wrong = await c('POST', '/auth/login', { body: { email: A.email, password: 'MauvaisMotDePasse1' } });
  assert.equal(unknown.status, 401); assert.deepEqual(unknown.body, wrong.body, 'même réponse : pas d\'énumération de comptes'); assert.ok(last);
});

test('journal d\'audit : aucun secret (mot de passe, jeton, hash) enregistré', async () => {
  const [rows] = await pool.query("SELECT meta FROM audit_logs WHERE meta IS NOT NULL AND (meta LIKE '%password%' OR meta LIKE '%\"token%' OR meta LIKE '%$2b$%' OR meta LIKE '%refresh%' OR meta LIKE '%secret%') LIMIT 5");
  assert.equal(rows.length, 0, JSON.stringify(rows));
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE password_hash NOT LIKE '$2%'"); assert.equal(Number(n), 0, 'mots de passe hachés (bcrypt)');
});

test('l\'erreur interne ne divulgue ni pile d\'appels ni SQL', async () => {
  const res = await c('GET', '/clients?page=abc', { token: A.token }); assert.ok(res.status < 500); assert.ok(!/at .*\.js|SELECT |mysql/i.test(res.raw));
  const nf = await c('GET', '/nimporte/quoi', { token: A.token }); assert.equal(nf.status, 404); assert.ok(!/stack|\.js:/i.test(nf.raw));
});

test('matrice des droits : lecture réservée, cohérente avec l\'application réelle', async () => {
  const m = (await c('GET', '/users/permissions-matrix', { token: A.token })).body.data;
  assert.equal(m.roles.length, 6); assert.deepEqual(m.modules.find((x) => x.module === 'invoice').rights.read_only, ['read']);
  assert.deepEqual(m.modules.find((x) => x.module === 'invoice').rights.owner, ['read', 'write', 'validate', 'delete']);
  assert.equal((await c('GET', '/users/permissions-matrix', { token: readOnly.token })).status, 403, 'réservé à ceux qui gèrent les utilisateurs');
});
