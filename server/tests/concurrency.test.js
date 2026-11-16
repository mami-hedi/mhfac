// Concurrence : des requêtes SIMULTANÉES (double clic, deux onglets, deux utilisateurs) ne doivent jamais
// créer de doublon, dépasser un solde, ni déplacer le stock deux fois.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { startApp, registerCompany, uniqueEmail, PASSWORD } from './helpers.js';

let app, A, client, tax19, wh;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const par = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const count = (rs, s) => rs.filter((r) => r.status === s).length;
const fresh = async (price = '100.000') => {
  const d = await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ description: 'Prestation', quantity: 1, unitPrice: price, taxRateId: tax19.id }] } });
  assert.equal(d.status, 201, d.raw); return d.body.data;
};
const issued = async (price) => { const d = await fresh(price); const i = await c('POST', `/invoices/${d.id}/issue`, { token: A.token }); assert.equal(i.status, 200, i.raw); return i.body.data; };

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Concurrence');
  client = (await c('POST', '/clients', { token: A.token, body: { name: 'Client concurrence' } })).body.data;
  tax19 = (await c('GET', '/tax-rates', { token: A.token })).body.data.find((t) => t.rate === '19.00');
  wh = (await c('GET', '/stock/warehouses', { token: A.token })).body.data[0];
});
after(() => app.close());

test('émission simultanée de la MÊME facture : une seule réussit, un seul numéro consommé', async () => {
  const d = await fresh();
  const rs = await par(8, () => c('POST', `/invoices/${d.id}/issue`, { token: A.token }));
  assert.equal(count(rs, 200), 1, rs.map((r) => r.status).join(','));
  assert.ok(rs.every((r) => r.status < 500), 'aucune 5xx');
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM invoices i JOIN companies c ON c.id = i.company_id WHERE c.public_id = ? AND i.number IS NOT NULL", [A.companyId]);
  const nums = (await c('GET', '/invoices?limit=100', { token: A.token })).body.data.map((x) => x.number).filter(Boolean);
  assert.equal(new Set(nums).size, nums.length, 'numéros uniques'); assert.ok(Number(n.n) >= 1);
});

test('numérotation : 12 factures émises en parallèle → numéros uniques et SANS TROU', async () => {
  const drafts = [];
  for (let i = 0; i < 12; i++) drafts.push(await fresh(`${100 + i}.000`));
  const rs = await par(12, (i) => c('POST', `/invoices/${drafts[i].id}/issue`, { token: A.token }));
  const ok = rs.filter((r) => r.status === 200);
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join(','));
  const seq = ok.map((r) => Number(r.body.data.number.split('-').pop())).sort((a, b) => a - b);
  assert.equal(new Set(seq).size, seq.length, 'numéros uniques');
  for (let i = 1; i < seq.length; i++) assert.equal(seq[i], seq[i - 1] + 1, `trou dans la numérotation : ${seq.join(',')}`);
});

test('règlements simultanés d\'un solde de 119 : jamais plus que le solde encaissé', async () => {
  const inv = await issued('100.000'); // 119 TTC
  const rs = await par(6, () => c('POST', '/payments', { token: A.token, body: { clientId: client.id, date: today, method: 'cash', allocations: [{ invoiceId: inv.id, amount: '119.000' }] } }));
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join(','));
  assert.equal(count(rs, 201), 1, `un seul règlement complet attendu : ${rs.map((r) => r.status)}`);
  const d = (await c('GET', `/invoices/${inv.id}`, { token: A.token })).body.data;
  assert.equal(d.paidAmount, '119.000'); assert.equal(d.paymentStatus, 'paid');
});

test('règlements partiels simultanés (6 × 40 sur 119) : au plus 2 acceptés, total ≤ 119', async () => {
  const inv = await issued('100.000');
  const rs = await par(6, () => c('POST', '/payments', { token: A.token, body: { clientId: client.id, date: today, method: 'cash', allocations: [{ invoiceId: inv.id, amount: '40.000' }] } }));
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join(','));
  assert.equal(count(rs, 201), 2, rs.map((r) => r.status).join(','));
  const d = (await c('GET', `/invoices/${inv.id}`, { token: A.token })).body.data;
  assert.equal(d.paidAmount, '80.000'); assert.equal(d.balance, '39.000');
});

test('avoirs simultanés sur la même ligne : on ne rembourse jamais plus que facturé', async () => {
  const inv = await issued('100.000');
  const line = (await c('GET', `/invoices/${inv.id}`, { token: A.token })).body.data.lines[0];
  const rs = await par(5, () => c('POST', '/credit-notes', { token: A.token, body: { invoiceId: inv.id, reason: 'Retour total', lines: [{ invoiceLineId: line.id, quantity: 1 }] } }));
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join(','));
  assert.equal(count(rs, 201), 1, rs.map((r) => `${r.status}:${r.body?.error?.code ?? ''}`).join(' '));
});

test('inscription simultanée avec la même adresse : un seul compte, jamais de 5xx', async () => {
  const email = uniqueEmail('dup');
  const rs = await par(6, () => c('POST', '/auth/register-company', { body: { companyName: 'Doublon SARL', fullName: 'Double Clic', email, password: PASSWORD } }));
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => `${r.status}:${r.raw.slice(0, 80)}`).join(' | '));
  assert.equal(count(rs, 201), 1);
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE email = ?', [email]); assert.equal(Number(n.n), 1);
});

test('rafraîchissement de session simultané (deux onglets) : pas de 5xx, session conservée', async () => {
  const rs = await par(5, () => c('POST', '/auth/refresh', { cookie: A.cookie }));
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join(','));
  assert.ok(count(rs, 200) >= 1);
});

test('validation simultanée du même bon d\'entrée : le stock n\'est déplacé qu\'UNE fois', async () => {
  const p = (await c('POST', '/products', { token: A.token, body: { name: 'Article stock concurrent', salePrice: '10', taxRateId: tax19.id, trackStock: true } })).body.data;
  const v = await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: today, lines: [{ productId: p.id, quantity: 10, unitCost: '5' }] } });
  assert.equal(v.status, 201, v.raw);
  const rs = await par(6, () => c('POST', `/stock/entries/${v.body.data.id}/validate`, { token: A.token }));
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join(','));
  assert.equal(count(rs, 200), 1, rs.map((r) => r.status).join(','));
  const lv = (await c('GET', `/stock/levels?q=${encodeURIComponent(p.name)}`, { token: A.token })).body.data.find((x) => x.productId === p.id);
  assert.equal(Number(lv.quantity), 10, 'stock = 10, pas 60');
});

test('sorties de stock simultanées (stock négatif interdit) : on ne sort jamais plus que le stock', async () => {
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { stock: { allowNegative: false } } });
  const p = (await c('POST', '/products', { token: A.token, body: { name: 'Article rare concurrent', salePrice: '10', taxRateId: tax19.id, trackStock: true } })).body.data;
  const e = await c('POST', '/stock/entries', { token: A.token, body: { warehouseId: wh.id, date: today, lines: [{ productId: p.id, quantity: 5, unitCost: '5' }] } });
  assert.equal((await c('POST', `/stock/entries/${e.body.data.id}/validate`, { token: A.token })).status, 200);
  const outs = [];
  for (let i = 0; i < 5; i++) { const w = await c('POST', '/stock/withdrawals', { token: A.token, body: { warehouseId: wh.id, date: today, reason: 'Consommation interne', lines: [{ productId: p.id, quantity: 3 }] } }); assert.equal(w.status, 201, w.raw); outs.push(w.body.data.id); }
  const rs = await par(5, (i) => c('POST', `/stock/withdrawals/${outs[i]}/validate`, { token: A.token }));
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join(','));
  assert.equal(count(rs, 200), 1, rs.map((r) => `${r.status}:${r.body?.error?.code ?? ''}`).join(' '));
  const lv = (await c('GET', `/stock/levels?q=${encodeURIComponent(p.name)}`, { token: A.token })).body.data.find((x) => x.productId === p.id);
  assert.equal(Number(lv.quantity), 2, 'stock restant = 2, jamais négatif');
});
