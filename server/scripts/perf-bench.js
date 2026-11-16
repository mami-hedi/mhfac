// Banc d'essai de performance (outil de développement, jamais lancé en production).
// Crée N entreprises avec ~2 ans de données réalistes (insertion SQL en masse) puis mesure les écrans les plus lourds.
//   node --env-file=.env.test scripts/perf-bench.js [entreprises=12] [factures_par_entreprise=7000]
// À exécuter sur une base de TEST uniquement.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pool } from '../src/config/db.js';
import { startApp, registerCompany } from '../tests/helpers.js';

const N = Number(process.argv[2] ?? 12); const INV = Number(process.argv[3] ?? 7000);
const CLIENTS = 200; const SUPPLIERS = 80; const PRODUCTS = 300; const LINES = 5;
const bulk = async (sql, rows, size = 1000) => { let first = null; for (let i = 0; i < rows.length; i += size) { const [r] = await pool.query(`${sql} VALUES ?`, [rows.slice(i, i + size)]); first ??= r.insertId; } return first; };
const day = (i, total) => new Date(Date.UTC(2025, 0, 1) + Math.floor((i / total) * 670) * 86400000).toISOString().slice(0, 10); // ~ janv. 2025 → oct. 2026
const m3 = (n) => (Math.round(n * 1000) / 1000).toFixed(3);

async function seedCompany(cid, uid) {
  const t0 = performance.now();
  const [[tax]] = await pool.query("SELECT id FROM tax_rates WHERE company_id = ? AND rate = 19 LIMIT 1", [cid]);
  let [[wh]] = await pool.query('SELECT id FROM warehouses WHERE company_id = ? LIMIT 1', [cid]);
  if (!wh) { const [r] = await pool.query('INSERT INTO warehouses (public_id, company_id, code, name) VALUES (?,?,?,?)', [randomUUID(), cid, 'PRINC', 'Dépôt principal']); wh = { id: r.insertId }; }
  const cl0 = await bulk('INSERT INTO clients (public_id, company_id, code, name, address, email, payment_terms_days)', Array.from({ length: CLIENTS }, (_, i) => [randomUUID(), cid, `C${String(i + 1).padStart(5, '0')}`, `Client ${i + 1} SARL`, `${i + 1} rue de la Liberté, Tunis`, `c${i}@exemple.tn`, 30]));
  const su0 = await bulk('INSERT INTO suppliers (public_id, company_id, code, name)', Array.from({ length: SUPPLIERS }, (_, i) => [randomUUID(), cid, `F${String(i + 1).padStart(5, '0')}`, `Fournisseur ${i + 1}`]));
  const pr0 = await bulk('INSERT INTO products (public_id, company_id, sku, name, sale_price, tax_rate_id, track_stock)', Array.from({ length: PRODUCTS }, (_, i) => [randomUUID(), cid, `P${String(i + 1).padStart(5, '0')}`, `Article ${i + 1}`, m3(10 + (i % 90) * 5), tax.id, 1]));
  // factures émises
  const invRows = []; const lineRows = []; const meta = [];
  for (let i = 0; i < INV; i++) {
    const d = day(i, INV); const cl = cl0 + (i * 7) % CLIENTS; let ht = 0; const ls = [];
    for (let l = 0; l < LINES; l++) { const q = 1 + ((i + l) % 5); const p = 10 + ((i * 3 + l * 11) % 90) * 5; const net = q * p; ht += net; ls.push([l + 1, pr0 + ((i + l) % PRODUCTS), `Article ${l}`, q, m3(p), 19, m3(net), 0, m3(net)]); }
    const tax19 = ht * 0.19; const ttc = ht + tax19; const net = ttc + 1; const paid = i % 10 < 7 ? net : (i % 10 < 8 ? net / 2 : 0);
    invRows.push([randomUUID(), cid, `FAC-${d.slice(0, 4)}-${String(i + 1).padStart(5, '0')}`, d.slice(0, 4), 'issued', d, d, cl, '{"name":"client"}', d, m3(ht), m3(ht), m3(tax19), m3(ttc), '1.000', m3(net), m3(paid), uid]);
    meta.push({ i, net, paid, cl }); lineRows.push(ls);
  }
  const iv0 = await bulk('INSERT INTO invoices (public_id, company_id, number, series, status, due_date, issue_date, client_id, client_snapshot, rate_date, subtotal, total_ht, total_tax, total_ttc, stamp_duty, net_payable, paid_amount, created_by)',
    invRows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17]]), 500);
  await bulk('INSERT INTO invoice_lines (invoice_id, position, product_id, description, quantity, unit_price, tax_rate, gross_amount, discount_amount, net_amount)', lineRows.flatMap((ls, i) => ls.map((l) => [iv0 + i, l[0], l[1], l[2], l[3], l[4], l[5], l[6], l[7], l[8]])), 2000);
  // règlements (70 % soldées, 10 % partielles)
  const pays = meta.filter((m) => m.paid > 0);
  const pa0 = await bulk('INSERT INTO payments (public_id, company_id, number, client_id, payment_date, method, amount, created_by)', pays.map((m) => [randomUUID(), cid, `REG-${day(m.i, INV).slice(0, 4)}-${String(m.i + 1).padStart(5, '0')}`, m.cl, day(m.i, INV), 'bank_transfer', m3(m.paid), uid]), 500);
  await bulk('INSERT INTO payment_allocations (payment_id, invoice_id, amount)', pays.map((m, k) => [pa0 + k, iv0 + m.i, m3(m.paid)]), 1000);
  // factures d'achat + règlements fournisseurs (1/4 du volume)
  const PIN = Math.floor(INV / 4); const piRows = [];
  for (let i = 0; i < PIN; i++) { const d = day(i, PIN); const s = su0 + (i * 5) % SUPPLIERS; const ht = 200 + (i % 40) * 25; piRows.push([randomUUID(), cid, `ACH-${d.slice(0, 4)}-${String(i + 1).padStart(5, '0')}`, `FA${i + 1}`, s, '{"name":"f"}', d, d, 'recorded', m3(ht), m3(ht * 1.19), m3(ht * 0.19), m3(ht * 1.19), i % 10 < 6 ? m3(ht * 1.19) : '0.000']); }
  const hasCol = async (t, c) => (await pool.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]))[0].length > 0;
  const cols = ['public_id', 'company_id', 'number', 'supplier_ref', 'supplier_id', 'supplier_snapshot', 'issue_date', 'due_date', 'status', 'total_ht', 'total_ttc', 'total_tax', 'net_payable', 'paid_amount'];
  if (await hasCol('purchase_invoices', 'total_ttc')) {
    const pi0 = await bulk(`INSERT INTO purchase_invoices (${cols.join(',')})`, piRows, 500);
    await bulk('INSERT INTO purchase_invoice_lines (purchase_invoice_id, position, description, quantity, unit_price, tax_rate, gross_amount, discount_amount, net_amount)', piRows.map((r, i) => [pi0 + i, 1, 'Achat', 1, r[9], 19, r[9], 0, r[9]]), 2000);
  }
  // mouvements de stock et journal d'audit
  await bulk('INSERT INTO stock_movements (public_id, company_id, product_id, warehouse_id, kind, quantity, unit_cost, total_cost, balance_after, avg_cost_after, movement_date, source_type, created_by)',
    Array.from({ length: 15000 }, (_, i) => [randomUUID(), cid, pr0 + (i % PRODUCTS), wh.id, i % 3 ? 'delivery' : 'entry', i % 3 ? -2 : 20, 5, 10, 100, 5, day(i, 15000), 'seed', uid]), 2000);
  await bulk('INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, ip, meta)', Array.from({ length: 20000 }, (_, i) => [cid, uid, i % 4 ? 'invoice.update' : 'payment.create', 'invoices', randomUUID(), '127.0.0.1', '{"n":1}']), 2000);
  return { ms: performance.now() - t0, invoiceId: null };
}

const p95 = (a) => [...a].sort((x, y) => x - y)[Math.max(0, Math.ceil(a.length * 0.95) - 1)];
async function measure(app, token, label, method, path, runs = 7, opts = {}) {
  const t = []; let status = 0; let size = 0;
  for (let i = 0; i < runs; i++) { const s = performance.now(); let r; try { r = await app.call(method, path, { token, ...opts }); } catch (e) { r = { status: 200, raw: 'binary' }; } t.push(performance.now() - s); status = r.status; size = (r.raw ?? '').length; }
  console.log(`${label.padEnd(46)} ${String(status).padEnd(4)} médiane ${String(Math.round(t.sort((a, b) => a - b)[Math.floor(t.length / 2)])).padStart(5)} ms   p95 ${String(Math.round(p95(t))).padStart(5)} ms   ${Math.round(size / 1024)} Ko`);
  return { label, status, med: t[Math.floor(t.length / 2)], p95: p95(t) };
}

const cleanup = async () => { await pool.query('SET FOREIGN_KEY_CHECKS = 0'); for (const t of ['invoice_lines', 'payment_allocations', 'purchase_invoice_lines']) await pool.query(`DELETE x FROM ${t} x LEFT JOIN ${t === 'invoice_lines' ? 'invoices' : t === 'payment_allocations' ? 'payments' : 'purchase_invoices'} y ON y.id = x.${t === 'invoice_lines' ? 'invoice_id' : t === 'payment_allocations' ? 'payment_id' : 'purchase_invoice_id'} LEFT JOIN companies c ON c.id = y.company_id WHERE c.name LIKE 'Perf %'`);
  for (const t of ['stock_movements', 'audit_logs', 'payments', 'invoices', 'purchase_invoices', 'products', 'clients', 'suppliers']) await pool.query(`DELETE x FROM ${t} x JOIN companies c ON c.id = x.company_id WHERE c.name LIKE 'Perf %'`);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1'); };
const app = await startApp();
try {
  await cleanup();
  console.log(`Création de ${N} entreprises × ${INV} factures (${CLIENTS} clients, ${PRODUCTS} articles, ${Math.floor(INV / 4)} achats, 15 000 mouvements, 20 000 lignes d'audit chacune)…`);
  const cos = []; for (let i = 0; i < N; i++) cos.push(await registerCompany(app.call, `Perf ${i + 1}`));
  const t0 = performance.now();
  for (const co of cos) { const [[c]] = await pool.query('SELECT c.id, m.user_id FROM companies c JOIN company_members m ON m.company_id = c.id WHERE c.public_id = ? LIMIT 1', [co.companyId]); await seedCompany(c.id, c.user_id); }
  console.log(`Données insérées en ${Math.round((performance.now() - t0) / 1000)} s`);
  for (const t of ['invoices', 'invoice_lines', 'payments', 'stock_movements', 'audit_logs', 'purchase_invoices']) { const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`); console.log(`  ${t.padEnd(18)} ${String(r.n).padStart(9)} lignes`); }
  await pool.query('ANALYZE TABLE invoices, invoice_lines, payments, payment_allocations, stock_movements, audit_logs, clients, products, purchase_invoices, suppliers');
  const A = cos[0]; const tk = A.token;
  const first = (await app.call('GET', '/invoices?limit=1', { token: tk })).body.data[0]; const client = (await app.call('GET', '/clients?limit=1', { token: tk })).body.data[0];
  const sup = (await app.call('GET', '/suppliers?limit=1', { token: tk })).body.data[0];
  console.log('\nÉcran / requête                                 code   temps');
  const res = [];
  const M = (...a) => measure(app, tk, ...a).then((r) => res.push(r));
  await M('Factures — liste page 1 (15)', 'GET', '/invoices?page=1&limit=15');
  await M('Factures — page 300', 'GET', '/invoices?page=300&limit=15');
  await M('Factures — recherche « FAC-2026-0042 »', 'GET', '/invoices?q=FAC-2026-0042');
  await M('Factures — filtre statut+dates+client', 'GET', `/invoices?status=issued&from=2026-01-01&to=2026-06-30&clientId=${client.id}`);
  await M('Factures — tri montant décroissant', 'GET', '/invoices?sort=total&order=desc');
  await M('Factures — filtre article (recherche avancée)', 'GET', '/invoices?q=Article%2017');
  await M('Factures — export CSV (jusqu\'à 5000)', 'GET', '/invoices/export?from=2026-01-01&to=2026-12-31', 3);
  await M('Facture — détail', 'GET', `/invoices/${first.id}`);
  await M('Facture — PDF', 'GET', `/invoices/${first.id}/pdf`, 5);
  await M('Clients — liste + recherche', 'GET', '/clients?q=Client%201');
  await M('Articles — liste + recherche', 'GET', '/products?q=Article%2020');
  await M('Règlements — liste', 'GET', '/payments');
  await M('Soldes clients — liste', 'GET', '/client-balances');
  await M('Solde client — détail + ancienneté', 'GET', `/client-balances/${client.id}`);
  await M('Relevé client (compte courant)', 'GET', `/client-balances/${client.id}/statement`);
  await M('Soldes fournisseurs — liste', 'GET', '/supplier-balances');
  await M('Solde fournisseur — détail', 'GET', `/supplier-balances/${sup.id}`);
  await M('Tableau de bord', 'GET', '/dashboard/summary');
  await M('Rapport des ventes (année)', 'GET', '/reports/sales?from=2025-01-01&to=2026-12-31');
  await M('Rapport TVA', 'GET', '/reports/vat?from=2025-01-01&to=2026-12-31');
  await M('Stock — niveaux', 'GET', '/stock/levels');
  await M('Stock — mouvements (page 1)', 'GET', '/stock/movements');
  await M('Retenue à la source — achats', 'GET', '/withholdings/purchases');
  await M('Notifications — résumé', 'GET', '/notifications/summary');
  // charge concurrente : 40 utilisateurs en même temps sur la liste de factures et les soldes
  const burst = async (label, path, n) => { const s = performance.now(); const rs = await Promise.all(Array.from({ length: n }, (_, i) => app.call('GET', path, { token: cos[i % N].token }))); const ms = performance.now() - s; console.log(`${label.padEnd(46)} ${rs.every((r) => r.status === 200) ? 'OK  ' : 'ERR '} ${n} requêtes simultanées : ${Math.round(ms)} ms au total (${Math.round(ms / n)} ms/requête)`); };
  console.log('');
  await burst('Rafale — liste de factures (12 entreprises)', '/invoices?page=2&limit=15', 48);
  await burst('Rafale — soldes clients', '/client-balances', 24);
  await burst('Rafale — tableau de bord', '/dashboard/summary', 24);
  const slow = res.filter((r) => r.med > 500 || r.status >= 400); console.log(slow.length ? `\nÀ examiner (>500 ms ou erreur) : ${slow.map((r) => `${r.label} [${r.status}] ${Math.round(r.med)} ms`).join(' ; ')}` : '\nAucune requête > 500 ms.');
} finally { await cleanup().catch((e) => console.error('nettoyage :', e.message)); await app.close(); }
