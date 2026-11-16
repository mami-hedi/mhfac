import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, noPurchase, readOnly, tax19, supp, cli;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const shift = (n) => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
const raw = async (path, token) => { const r = await fetch(`${app.base}${path}`, { headers: { authorization: `Bearer ${token}` } }); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, buf, text: buf.toString('utf8') }; };
let n = 0; const ref = () => `BAL-${Date.now()}-${++n}`;

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Soldes A'); B = await registerCompany(app.call, 'Soldes B');
  noPurchase = await addMember(app.call, A, 'stock_manager'); readOnly = await addMember(app.call, A, 'read_only');
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
  supp = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Soldes' } }), 201);
  cli = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Soldes' } }), 201);
});
after(() => app.close());

test('soldes fournisseurs : retenue, avoir, règlement partiel, avance, ancienneté, relevé', async () => {
  const mk = async (unit, due, extra = {}) => { const d = ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: supp.id, issueDate: shift(-60), dueDate: due, supplierRef: ref(), lines: [{ description: 'Achat', quantity: 1, unitPrice: unit, taxRateId: tax19.id }], ...extra } }), 201); ok(await c('POST', `/purchase-invoices/${d.id}/record`, { token: A.token })); return d; };
  const p1 = await mk('1000', shift(-40), { withholdingPct: '1.5' }); // TTC 1190, retenue 17.850 -> net 1172.150, échu depuis 40 j (31-60)
  const p2 = await mk('500', shift(10)); // 595, non échu
  const p3 = await mk('100', shift(-5)); // 119, échu depuis 5 j (1-30) puis annulée -> exclue
  ok(await c('POST', `/purchase-invoices/${p3.id}/cancel`, { token: A.token, body: { reason: 'Erreur' } }));
  assert.equal(ok(await c('GET', '/supplier-balances', { token: A.token }))[0].total, '1767.150', 'p1 net + p2');
  // règlement partiel de p1 (172.150) + avance de 50 non affectée
  ok(await c('POST', '/supplier-payments', { token: A.token, body: { supplierId: supp.id, date: today, method: 'bank_transfer', allocations: [{ invoiceId: p1.id, amount: '172.150' }] } }), 201);
  ok(await c('POST', '/supplier-payments', { token: A.token, body: { supplierId: supp.id, date: today, method: 'cash', amount: '50', allocations: [] } }), 201);
  // avoir de 1 article sur p2 (595)
  const full = ok(await c('GET', `/purchase-invoices/${p2.id}`, { token: A.token }));
  const cn = ok(await c('POST', '/purchase-credit-notes', { token: A.token, body: { invoiceId: p2.id, supplierRef: ref(), reason: 'Retour', lines: [{ invoiceLineId: full.lines[0].id, quantity: 1 }] } }), 201);
  ok(await c('POST', `/purchase-credit-notes/${cn.id}/record`, { token: A.token }));
  const r = await c('GET', '/supplier-balances', { token: A.token }); assert.equal(r.status, 200, r.raw);
  const row = r.body.data[0];
  assert.equal(row.name, 'Fournisseur Soldes'); assert.equal(row.currency, 'TND'); assert.equal(row.openInvoices, 1, 'p2 soldée par l\'avoir, p3 annulée');
  assert.equal(row.total, '1000.000'); assert.equal(row.overdue, '1000.000'); assert.equal(row.notDue, '0.000'); assert.equal(row.aging.d31_60, '1000.000'); assert.equal(row.aging.d1_30, '0.000');
  assert.equal(row.advances, '50.000'); assert.equal(row.net, '950.000'); assert.equal(row.oldestOverdue, shift(-40)); assert.equal(row.lastPayment, today);
  assert.equal(r.body.meta.totals[0].net, '950.000'); assert.equal(r.body.meta.asOf, today);
  // filtres
  assert.equal(ok(await c('GET', '/supplier-balances?overdueOnly=true', { token: A.token })).length, 1); assert.equal(ok(await c('GET', '/supplier-balances?q=zzz', { token: A.token })).length, 0);
  assert.equal(ok(await c('GET', '/supplier-balances?minAmount=2000', { token: A.token })).length, 0); assert.equal(ok(await c('GET', '/supplier-balances?currency=EUR', { token: A.token })).length, 0);
  // détail
  const d = ok(await c('GET', `/supplier-balances/${supp.id}`, { token: A.token }));
  assert.equal(d.invoices.length, 1); assert.equal(d.invoices[0].balance, '1000.000'); assert.equal(d.invoices[0].daysOverdue, 40); assert.equal(d.invoices[0].overdue, true);
  assert.equal(d.unallocatedPayments.length, 1); assert.equal(d.unallocatedPayments[0].amount, '50.000');
  // relevé : factures +, avoir/règlements −, solde cumulé = solde net (les factures annulées n'y figurent pas)
  const st = ok(await c('GET', `/supplier-balances/${supp.id}/statement`, { token: A.token }));
  assert.equal(st.lines.filter((l) => l.type === 'invoice').length, 2); assert.equal(st.lines.filter((l) => l.type === 'credit_note').length, 1); assert.equal(st.lines.filter((l) => l.type === 'payment').length, 2);
  assert.equal(st.closing, '950.000', 'relevé = solde net'); assert.equal(st.opening, '0.000');
  assert.equal(ok(await c('GET', `/supplier-balances/${supp.id}/statement?from=${shift(1)}`, { token: A.token })).closing, '950.000');
  assert.equal(ok(await c('GET', `/supplier-balances/${supp.id}/statement?from=${shift(1)}`, { token: A.token })).opening, '950.000');
  assert.equal((await c('GET', `/supplier-balances/${supp.id}/statement?from=${shift(1)}&to=${shift(-1)}`, { token: A.token })).status, 422);
  // CSV
  const e = await raw('/supplier-balances/export', A.token); assert.equal(e.status, 200); assert.ok(e.buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))); assert.ok(e.text.includes('Fournisseur Soldes') && e.text.includes('950,000'));
  const es = await raw(`/supplier-balances/${supp.id}/statement/export`, A.token); assert.equal(es.status, 200); assert.ok(es.text.includes('Solde initial') && es.text.includes('Règlement'));
  // droits et isolation
  assert.equal((await c('GET', '/supplier-balances', { token: readOnly.token })).status, 200);
  assert.equal((await c('GET', '/supplier-balances', { token: noPurchase.token })).status, 200, 'stock_manager lit les achats');
  assert.equal(ok(await c('GET', '/supplier-balances', { token: B.token })).length, 0);
  assert.equal((await c('GET', `/supplier-balances/${supp.id}`, { token: B.token })).status, 404);
  assert.equal((await c('GET', `/supplier-balances/${supp.id}/statement`, { token: B.token })).status, 404);
  assert.equal((await raw('/supplier-balances/export', B.token)).text.trim().split('\r\n').length, 1);
  assert.equal((await fetch(`${app.base}/supplier-balances`)).status, 401);
});

test('créances clients : même règle côté ventes, avoir, règlement partiel, avance, relevé', async () => {
  const mk = async (unit, due) => { const d = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: cli.id, issueDate: shift(-100), dueDate: due, lines: [{ description: 'Service', quantity: 1, unitPrice: unit, taxRateId: tax19.id }] } }), 201); ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token })); return d; };
  const i1 = await mk('1000', shift(-95)); // TTC 1190 (+ timbre éventuel), échu +90 j
  const i2 = await mk('200', shift(30)); // non échu
  const total = (x) => Number(ok.call(null, x).total);
  let list = ok(await c('GET', '/client-balances', { token: A.token })); assert.equal(list.length, 1);
  const base = list[0]; assert.equal(base.name, 'Client Soldes'); assert.equal(base.openInvoices, 2); assert.equal(base.aging.over90, ok(await c('GET', `/invoices/${i1.id}`, { token: A.token })).netPayable);
  const n1 = ok(await c('GET', `/invoices/${i1.id}`, { token: A.token })).netPayable; const n2 = ok(await c('GET', `/invoices/${i2.id}`, { token: A.token })).netPayable;
  assert.equal(base.notDue, n2); assert.equal(Number(base.total).toFixed(3), (Number(n1) + Number(n2)).toFixed(3));
  ok(await c('POST', '/payments', { token: A.token, body: { clientId: cli.id, date: today, method: 'cash', allocations: [{ invoiceId: i1.id, amount: '100.000' }] } }), 201);
  ok(await c('POST', '/payments', { token: A.token, body: { clientId: cli.id, date: today, method: 'cash', amount: '25', allocations: [] } }), 201);
  list = ok(await c('GET', '/client-balances', { token: A.token })); const b = list[0];
  assert.equal(Number(b.total).toFixed(3), (Number(n1) + Number(n2) - 100).toFixed(3)); assert.equal(b.advances, '25.000'); assert.equal(Number(b.net).toFixed(3), (Number(n1) + Number(n2) - 125).toFixed(3));
  assert.equal(b.oldestOverdue, shift(-95)); assert.equal(ok(await c('GET', '/client-balances?overdueOnly=true', { token: A.token })).length, 1);
  const st = ok(await c('GET', `/client-balances/${cli.id}/statement`, { token: A.token })); assert.equal(st.closing, b.net); assert.equal(st.lines.filter((l) => l.type === 'payment').length, 2);
  const d = ok(await c('GET', `/client-balances/${cli.id}`, { token: A.token })); assert.equal(d.invoices.length, 2); assert.equal(d.invoices.find((x) => x.overdue).daysOverdue, 95);
  assert.ok((await raw('/client-balances/export', A.token)).text.includes('Client Soldes'));
  // isolation et droits
  assert.equal(ok(await c('GET', '/client-balances', { token: B.token })).length, 0); assert.equal((await c('GET', `/client-balances/${cli.id}`, { token: B.token })).status, 404);
  assert.equal((await c('GET', '/client-balances', { token: readOnly.token })).status, 200);
  assert.equal((await c('GET', '/client-balances', { token: noPurchase.token })).status, 403, 'stock_manager n\'a pas invoice.read');
  assert.equal((await c('GET', '/client-balances?sort=hack', { token: A.token })).status, 400);
  void total;
});
