import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';
import { pool } from '../src/config/db.js';

let app, A, B, salesU, stockMgr, client, evil, sup, tax19, prodA, prodB;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const csv = async (path, token) => { const r = await fetch(`${app.base}${path}`, { headers: { authorization: `Bearer ${token}` } }); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, text: buf.toString('utf8').replace(/^\uFEFF/, '\uFEFF'), bom: buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), headers: r.headers }; };
let n = 0;
const L = (p, q, price, desc) => ({ productId: p?.id, description: desc ?? p?.name ?? 'Prestation', quantity: q, unitPrice: price, taxRateId: tax19.id });
const mk = async (cl, date, lines, extra = {}) => ok(await c('POST', '/invoices', { token: A.token, body: { clientId: cl.id, issueDate: date, dueDate: date, lines, ...extra } }), 201);
const issue = async (d) => ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token }));

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Filtres A'); B = await registerCompany(app.call, 'Filtres B'); stockMgr = await addMember(app.call, A, 'stock_manager'); salesU = await addMember(app.call, A, 'sales');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Filtres' } }), 201);
  evil = ok(await c('POST', '/clients', { token: A.token, body: { name: '=HYPERLINK("http://x")' } }), 201);
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Filtres' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
  prodA = ok(await c('POST', '/products', { token: A.token, body: { name: 'Écran 24 pouces', salePrice: '100', taxRateId: tax19.id, trackStock: true } }), 201);
  prodB = ok(await c('POST', '/products', { token: A.token, body: { name: 'Câble HDMI', salePrice: '10', taxRateId: tax19.id } }), 201);
});
after(() => app.close());

test('liste : 15 par page par défaut, plus récents en haut, pagination cohérente', async () => {
  for (let i = 1; i <= 17; i += 1) await mk(client, `2026-02-${String(i).padStart(2, '0')}`, [L(null, 1, '10', 'Ligne pagination')]);
  const r1 = await c('GET', '/invoices?q=pagination', { token: A.token });
  assert.equal(r1.body.meta.limit, 15); assert.equal(r1.body.meta.total, 17); assert.equal(r1.body.meta.pages, 2); assert.equal(r1.body.data.length, 15);
  const dates = r1.body.data.map((d) => d.issueDate); assert.deepEqual(dates, [...dates].sort().reverse(), 'date décroissante');
  assert.equal(dates[0], '2026-02-17');
  const r2 = await c('GET', '/invoices?q=pagination&page=2', { token: A.token }); assert.equal(r2.body.data.length, 2); assert.equal(r2.body.data[1].issueDate, '2026-02-01');
  const ids = new Set([...r1.body.data, ...r2.body.data].map((d) => d.id)); assert.equal(ids.size, 17, 'aucun doublon entre les pages');
  assert.equal((await c('GET', '/invoices?limit=101', { token: A.token })).status, 400);
});

test('filtres avancés : période, montant TTC, produit, recherche dans lignes et notes, bornes incohérentes', async () => {
  const a = await mk(client, '2026-03-05', [L(prodA, 1, '100')], { notes: 'Livraison urgente chantier Hammamet' }); // 119,000 TTC
  const b = await mk(client, '2026-03-20', [L(prodB, 2, '10', 'Câble réseau blindé')]); // 23,800 TTC
  const ids = async (qs) => ok(await c('GET', `/invoices?${qs}`, { token: A.token })).map((d) => d.id);
  assert.deepEqual(await ids('from=2026-03-01&to=2026-03-31'), [b.id, a.id], 'période, plus récent en premier');
  assert.deepEqual(await ids('from=2026-03-10&to=2026-03-31'), [b.id]);
  assert.deepEqual(await ids('minAmount=100&from=2026-03-01&to=2026-03-31'), [a.id], 'TTC minimum');
  assert.deepEqual(await ids('maxAmount=30&from=2026-03-01&to=2026-03-31'), [b.id], 'TTC maximum');
  assert.deepEqual(await ids(`productId=${prodA.id}`), [a.id]);
  assert.deepEqual(await ids('q=chantier'), [a.id], 'recherche dans les notes');
  assert.deepEqual(await ids('q=blind%C3%A9'), [b.id], 'recherche dans les désignations de lignes');
  assert.deepEqual(await ids(`productId=${prodA.id}&minAmount=500`), [], 'filtres cumulés');
  assert.equal((await c('GET', '/invoices?from=2026-04-01&to=2026-03-01', { token: A.token })).status, 422);
  assert.equal((await c('GET', '/invoices?minAmount=50&maxAmount=10', { token: A.token })).status, 422);
  assert.equal((await c('GET', '/invoices?minAmount=abc', { token: A.token })).status, 400);
  assert.deepEqual(await ids("q=%27%20OR%201%3D1%20--"), [], 'aucune injection SQL');
  // produit d'une autre entreprise : aucun résultat, rien n'est révélé
  assert.deepEqual(await (async () => ok(await c('GET', `/invoices?productId=${prodA.id}`, { token: B.token })).map((d) => d.id))(), []);
});

test('export CSV factures : même filtres que la liste, format Excel français, protection formule, journalisé, isolé', async () => {
  const bad = await mk(evil, '2026-03-25', [L(null, 1, '50', 'Service')]); await issue(bad);
  const e = await csv('/invoices/export?from=2026-03-01&to=2026-03-31', A.token);
  assert.equal(e.status, 200); assert.match(e.headers.get('content-type'), /text\/csv/); assert.match(e.headers.get('content-disposition'), /factures\.csv/);
  assert.ok(e.text.startsWith('﻿'), 'BOM UTF-8 pour Excel');
  const lines = e.text.trim().split('\r\n'); assert.equal(lines[0].split(';')[0].replace('﻿', ''), 'N°'); assert.equal(lines.length, 1 + 3, 'en-tête + 3 factures de mars');
  assert.ok(lines.some((l) => l.includes('119,000')), 'virgule décimale');
  assert.ok(lines.some((l) => l.includes("'=HYPERLINK")), 'une cellule qui commence par = est neutralisée');
  assert.ok(lines[1].includes('25/03/2026'), 'plus récent en premier, date JJ/MM/AAAA');
  assert.equal(e.headers.get('x-export-truncated'), '0'); assert.equal(e.headers.get('x-total-count'), '3');
  const same = ok(await c('GET', '/invoices?from=2026-03-01&to=2026-03-31&limit=100', { token: A.token })); assert.equal(same.length, 3, 'liste et export concordent');
  const [[a]] = await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE action = 'invoice.export'"); assert.ok(a.n >= 1, 'export tracé');
  assert.equal((await csv('/invoices/export', stockMgr.token)).status, 403, 'sans droit de lecture des factures');
  assert.equal((await csv('/invoices/export?from=2026-04-01&to=2026-03-01', A.token)).status, 422);
  const other = await csv('/invoices/export', B.token); assert.equal(other.text.trim().split('\r\n').length, 1, 'une autre entreprise n\'exporte rien de A');
  assert.equal((await fetch(`${app.base}/invoices/export`)).status, 401);
});

test('achats : filtres (fournisseur, TTC, produit, recherche lignes) et export', async () => {
  const mkp = async (ref, date, lines, extra = {}) => ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: date, supplierRef: ref, lines, ...extra } }), 201);
  const p1 = await mkp(`FL-${++n}`, '2026-04-02', [L(prodA, 1, '200', 'Écran pro')], { notes: 'Commande exceptionnelle' }); // 238 TTC
  const p2 = await mkp(`FL-${++n}`, '2026-04-09', [L(prodB, 3, '5', 'Câbles')]); // 17,850 TTC
  const ids = async (qs) => ok(await c('GET', `/purchase-invoices?${qs}`, { token: A.token })).map((d) => d.id);
  assert.deepEqual(await ids('from=2026-04-01&to=2026-04-30'), [p2.id, p1.id]);
  assert.deepEqual(await ids('minAmount=100'), [p1.id]); assert.deepEqual(await ids('maxAmount=20'), [p2.id]);
  assert.deepEqual(await ids(`productId=${prodB.id}`), [p2.id]); assert.deepEqual(await ids('q=exceptionnelle'), [p1.id]); assert.deepEqual(await ids('q=C%C3%A2bles'), [p2.id]);
  assert.deepEqual(await ids(`supplierId=${sup.id}&from=2026-04-05`), [p2.id]);
  const e = await csv('/purchase-invoices/export?from=2026-04-01&to=2026-04-30', A.token); assert.equal(e.status, 200);
  const lines = e.text.trim().split('\r\n'); assert.equal(lines.length, 3); assert.ok(lines[0].includes('N° fournisseur')); assert.ok(lines[2].includes('238,000'));
  assert.equal((await csv('/purchase-invoices/export', salesU.token)).status, 403);
});

test('stock : mouvements (plus récents en haut) et niveaux, exports CSV', async () => {
  const wh = ok(await c('GET', '/stock/warehouses', { token: A.token }))[0];
  const e1 = ok(await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: '2026-05-01', lines: [{ productId: prodA.id, quantity: 5, unitCost: '80.000' }] } }), 201); ok(await c('POST', `/stock/entries/${e1.id}/validate`, { token: A.token }));
  const t = ok(await c('POST', '/products', { token: A.token, body: { name: 'Suivi test', salePrice: '5', taxRateId: tax19.id, trackStock: true } }), 201);
  const e2 = ok(await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: '2026-05-10', lines: [{ productId: t.id, quantity: 3, unitCost: '2.000' }] } }), 201); ok(await c('POST', `/stock/entries/${e2.id}/validate`, { token: A.token }));
  const mv = ok(await c('GET', '/stock/movements', { token: stockMgr.token })); assert.ok(mv.length >= 1); assert.equal(mv[0].date, '2026-05-10', 'plus récent en haut');
  const e = await csv('/stock/movements/export?from=2026-05-01&to=2026-05-31', stockMgr.token); assert.equal(e.status, 200); assert.ok(e.text.startsWith('﻿'));
  assert.ok(e.text.includes('10/05/2026')); assert.ok(e.text.trim().split('\r\n').length >= 2);
  assert.equal((await c('GET', '/stock/movements?from=2026-06-01&to=2026-05-01', { token: stockMgr.token })).status, 422);
  const lv = await csv('/stock/levels/export', stockMgr.token); assert.equal(lv.status, 200); assert.ok(lv.text.includes('Suivi test')); assert.ok(lv.text.includes('3,0000') || lv.text.includes('3,000'));
  assert.equal((await csv('/stock/levels/export', B.token)).text.includes('Suivi test'), false, 'isolation');
});
