// Fuzz : AUCUNE route (écriture comme lecture) ne doit répondre 5xx sur une entrée hostile. Une 4xx propre est attendue.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { startApp, registerCompany } from './helpers.js';
import { listRoutes } from './helpers_routes.js';

let app, A, routes;
const c = (...a) => app.call(...a);
const UUID0 = '00000000-0000-4000-8000-000000000000';
const fill = (path, id) => path.replace(/:[A-Za-z]+/g, id);
const rel = (r) => r.path.replace('/api/v1', '');
before(async () => { app = await startApp(); routes = listRoutes(createApp()); A = await registerCompany(app.call, 'Fuzz A'); });
after(() => app.close());

const HOSTILE = ['', ' ', 'x'.repeat(100_000), "'; DROP TABLE users; --", '<img src=x onerror=alert(1)>', '\u0000', '\ud800', '9'.repeat(40), '-1', '0', '1e999', 'NaN', 'null', 'true',
  null, true, false, 0, -1, 1e308, -1e308, 99999999999999999999, 0.0000001, [], {}, [[]], { $ne: null }, [null], '9999-99-99', '0000-00-00', '2026-02-30', 'not-a-uuid', UUID0];
const FIELDS = ['name', 'email', 'password', 'fullName', 'description', 'notes', 'terms', 'reference', 'reason', 'message', 'subject', 'to', 'taxId', 'sku', 'barcode', 'phone', 'address', 'code', 'token', 'status', 'type', 'method',
  'currency', 'exchangeRate', 'issueDate', 'dueDate', 'date', 'paymentDate', 'startDate', 'endDate', 'validUntil', 'from', 'to', 'quantity', 'unitPrice', 'price', 'amount', 'discountPct', 'globalDiscountPct', 'withholdingPct',
  'stampDuty', 'applyStampDuty', 'fodec', 'taxRateId', 'productId', 'clientId', 'supplierId', 'warehouseId', 'categoryId', 'projectId', 'invoiceId', 'accountId', 'roleCode', 'companyId', 'planCode', 'page', 'limit', 'q', 'lines', 'allocations', 'items', 'settings'];

const bodies = () => {
  const out = [{}, [], 'texte', 123, { lines: [{}] }, { lines: 'x' }, { allocations: [{ invoiceId: UUID0, amount: '1e999' }] }];
  for (const v of HOSTILE) { const o = {}; for (const f of FIELDS) o[f] = v; out.push(o); }
  // ligne de document hostile avec des identifiants et montants plausibles
  for (const v of HOSTILE) out.push({ clientId: UUID0, supplierId: UUID0, issueDate: '2026-01-15', lines: [{ description: 'x', quantity: v, unitPrice: v, discountPct: v, taxRateId: UUID0, productId: v }] });
  return out;
};

test('écritures : aucune erreur 5xx sur des corps hostiles (toutes les routes POST/PUT/PATCH/DELETE)', async () => {
  const bad = new Map();
  const list = routes.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && !r.path.startsWith('/api/v1/platform') && !/\/auth\/(change-password|logout)$/.test(r.path));
  for (const r of list) {
    for (const b of bodies()) {
      let res;
      try { res = await c(r.method, fill(rel(r), UUID0), { token: A.token, body: b }); } catch (e) { res = /not valid JSON/.test(e.message) ? { status: 200 } : { status: `EXC ${e.message}` }; } // réponse non JSON = PDF/CSV valide
      if (typeof res.status !== 'number' || res.status >= 500) { const k = `${r.method} ${r.path}`; if (!bad.has(k)) bad.set(k, `${res.status} ${(res.raw ?? '').slice(0, 160)}`); }
    }
  }
  assert.deepEqual([...bad.entries()], [], `5xx sur :\n${[...bad.entries()].map(([k, v]) => `${k} -> ${v}`).join('\n')}`);
});

// Montants extrêmes sur de VRAIS documents (client, fournisseur, article existants) : aucun débordement DECIMAL(15,3) ne doit finir en 500
// ni en total tronqué silencieusement.
test('montants extrêmes : refus propre (4xx) ou calcul exact, jamais 5xx', async () => {
  const tax = (await c('GET', '/tax-rates', { token: A.token })).body.data.find((t) => t.rate === '19.00');
  const cl = (await c('POST', '/clients', { token: A.token, body: { name: 'Fuzz client' } })).body.data;
  const sp = (await c('POST', '/suppliers', { token: A.token, body: { name: 'Fuzz fournisseur' } })).body.data;
  const today = new Date().toISOString().slice(0, 10);
  const big = ['99999999999999.999', '999999999999999', '1000000000000', '9999999999.999', '1e15', '0.0001', '12345678901234567890', '-5', '0'];
  const bad = [];
  const rec = (label, res) => { if (res.status >= 500) bad.push(`${label} -> ${res.status} ${(res.raw ?? '').slice(0, 120)}`); return res; };
  for (const v of big) {
    const line = { description: 'x', quantity: '1', unitPrice: v, taxRateId: tax.id };
    const bigQty = { description: 'x', quantity: v, unitPrice: '1000', taxRateId: tax.id };
    for (const l of [line, bigQty, { ...line, discountPct: v }]) {
      rec(`POST /sales/preview ${JSON.stringify(l)}`, await c('POST', '/sales/preview', { token: A.token, body: { clientId: cl.id, issueDate: today, lines: [l] } }));
      for (const [path, body] of [['/invoices', { clientId: cl.id, issueDate: today, lines: [l] }], ['/quotes', { clientId: cl.id, issueDate: today, lines: [l] }],
        ['/purchase-invoices', { supplierId: sp.id, issueDate: today, supplierRef: `R${Math.random()}`, lines: [l] }]]) {
        const r = rec(`POST ${path} ${JSON.stringify(l)}`, await c('POST', path, { token: A.token, body }));
        if (r.status === 201) { const d = r.body.data; if (!/^\d{1,12}\.\d{3}$/.test(String(d.totalTtc ?? d.total_ttc))) bad.push(`${path} total hors plage accepté : ${d.totalTtc}`); }
      }
    }
    rec(`POST /products ${v}`, await c('POST', '/products', { token: A.token, body: { name: `P${Math.random()}`, salePrice: v, taxRateId: tax.id } }));
    rec(`POST /clients creditLimit ${v}`, await c('POST', '/clients', { token: A.token, body: { name: `C${Math.random()}`, creditLimit: v, paymentTermsDays: v } }));
    rec(`POST /payments ${v}`, await c('POST', '/payments', { token: A.token, body: { clientId: cl.id, paymentDate: today, method: 'cash', amount: v, allocations: [] } }));
    rec(`POST /supplier-payments ${v}`, await c('POST', '/supplier-payments', { token: A.token, body: { supplierId: sp.id, paymentDate: today, method: 'cash', amount: v, allocations: [] } }));
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});
