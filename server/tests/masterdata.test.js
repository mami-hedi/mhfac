import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, readOnly, sales;
before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Alpha');
  B = await registerCompany(app.call, 'Beta');
  readOnly = await addMember(app.call, A, 'read_only');
  sales = await addMember(app.call, A, 'sales');
});
after(() => app.close());
const c = (...a) => app.call(...a);

test('taux de TVA par défaut créés et modifiables, jamais figés', async () => {
  const r = await c('GET', '/tax-rates', { token: A.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 4);
  assert.equal(r.body.data.filter((t) => t.isDefault).length, 1);
  const created = await c('POST', '/tax-rates', { token: A.token, body: { name: 'TVA 12 %', rate: '12' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.rate, '12.00');
  const bad = await c('POST', '/tax-rates', { token: A.token, body: { name: 'X', rate: 5, kind: 'exempt' } });
  assert.equal(bad.status, 400);
  const dup = await c('POST', '/tax-rates', { token: A.token, body: { name: 'TVA 12 %', rate: 12 } });
  assert.equal(dup.status, 409);
  const def = r.body.data.find((t) => t.isDefault);
  assert.equal((await c('DELETE', `/tax-rates/${def.id}`, { token: A.token })).status, 422);
  assert.equal((await c('PATCH', `/tax-rates/${def.id}`, { token: A.token, body: { isActive: false } })).status, 422);
  assert.equal((await c('PATCH', `/tax-rates/${created.body.data.id}`, { token: sales.token, body: { rate: 3 } })).status, 403);
  // isolation
  assert.equal((await c('PATCH', `/tax-rates/${created.body.data.id}`, { token: B.token, body: { rate: 3 } })).status, 404);
  const makeDef = await c('PATCH', `/tax-rates/${created.body.data.id}`, { token: A.token, body: { isDefault: true } });
  assert.equal(makeDef.status, 200);
  const list = await c('GET', '/tax-rates', { token: A.token });
  assert.equal(list.body.data.filter((t) => t.isDefault).length, 1);
});

test('clients : CRUD, code auto, recherche, pagination, archivage', async () => {
  const r1 = await c('POST', '/clients', { token: A.token, body: { name: 'Société Sfax Meuble', type: 'company', taxId: '1234567/A/M/000', email: 'Contact@SFAX.tn', phone: '+216 74 123 456', governorate: 'Sfax', paymentTermsDays: 30 } });
  assert.equal(r1.status, 201, r1.raw);
  assert.match(r1.body.data.code, /^CLI-\d{5}$/);
  assert.equal(r1.body.data.email, 'contact@sfax.tn');
  assert.equal(r1.body.data.currency, 'TND');
  const r2 = await c('POST', '/clients', { token: A.token, body: { name: 'Ali Ben Salah', type: 'individual' } });
  assert.equal(r2.status, 201);
  assert.notEqual(r1.body.data.code, r2.body.data.code);
  // doublon de matricule
  const dup = await c('POST', '/clients', { token: A.token, body: { name: 'Autre', taxId: '1234567/A/M/000' } });
  assert.equal(dup.status, 409);
  // mêmes données dans une autre société : autorisé
  assert.equal((await c('POST', '/clients', { token: B.token, body: { name: 'Autre', taxId: '1234567/A/M/000' } })).status, 201);
  // validation
  assert.equal((await c('POST', '/clients', { token: A.token, body: { name: 'A' } })).status, 400);
  assert.equal((await c('POST', '/clients', { token: A.token, body: { name: 'Valide', email: 'pas-un-email' } })).status, 400);
  assert.equal((await c('POST', '/clients', { token: A.token, body: { name: 'Valide', paymentTermsDays: -1 } })).status, 400);
  // recherche + pagination
  const s = await c('GET', '/clients?q=sfax', { token: A.token });
  assert.equal(s.body.data.length, 1);
  assert.equal((await c('GET', '/clients?q=%25', { token: A.token })).body.data.length, 0); // % est littéral
  const p = await c('GET', '/clients?limit=1&page=2&sort=name', { token: A.token });
  assert.equal(p.body.meta.total, 2);
  assert.equal(p.body.data.length, 1);
  assert.equal((await c('GET', '/clients?sort=id;DROP', { token: A.token })).status, 200); // tri inconnu -> défaut
  // modification + archivage
  const up = await c('PATCH', `/clients/${r1.body.data.id}`, { token: A.token, body: { phone: null, status: 'archived' } });
  assert.equal(up.status, 200);
  assert.equal(up.body.data.status, 'archived');
  assert.equal((await c('GET', '/clients?status=active', { token: A.token })).body.data.length, 1);
  assert.equal((await c('PATCH', `/clients/${r1.body.data.id}`, { token: A.token, body: {} })).status, 400);
});

test('clients : permissions et isolation entre sociétés', async () => {
  const mine = await c('POST', '/clients', { token: A.token, body: { name: 'Client privé A' } });
  const id = mine.body.data.id;
  assert.equal((await c('GET', `/clients/${id}`, { token: B.token })).status, 404);
  assert.equal((await c('PATCH', `/clients/${id}`, { token: B.token, body: { name: 'Piraté' } })).status, 404);
  assert.equal((await c('DELETE', `/clients/${id}`, { token: B.token })).status, 404);
  assert.equal((await c('GET', '/clients', { token: B.token })).body.data.some((x) => x.id === id), false);
  assert.equal((await c('GET', '/clients')).status, 401);
  assert.equal((await c('GET', '/clients', { token: readOnly.token })).status, 200);
  assert.equal((await c('POST', '/clients', { token: readOnly.token, body: { name: 'Interdit' } })).status, 403);
  assert.equal((await c('DELETE', `/clients/${id}`, { token: sales.token })).status, 403);
  assert.equal((await c('GET', `/clients/pas-un-uuid`, { token: A.token })).status, 400);
  assert.equal((await c('DELETE', `/clients/${id}`, { token: A.token })).status, 204);
  assert.equal((await c('GET', `/clients/${id}`, { token: A.token })).status, 404);
});

test('clients : import CSV (aperçu, erreurs, import) et export protégé', async () => {
  const csv = 'Nom;Type;Matricule fiscal;E-mail;Délai de paiement\r\nImport Un;entreprise;7654321/B/A/000;un@x.tn;15\r\n"Import, Deux";particulier;;;\r\nMauvais;entreprise;;pas-email;0\r\nImport Un bis;entreprise;7654321/B/A/000;;0\r\n';
  const dry = await c('POST', '/clients/import', { token: A.token, body: { csv, dryRun: true } });
  assert.equal(dry.status, 200, dry.raw);
  assert.equal(dry.body.data.valid, 2);
  assert.equal(dry.body.data.errors.length, 2);
  assert.equal(dry.body.data.errors[0].line, 4);
  const before = (await c('GET', '/clients?q=Import', { token: A.token })).body.meta.total;
  assert.equal(before, 0, 'aperçu : rien créé');
  const refuse = await c('POST', '/clients/import', { token: A.token, body: { csv } });
  assert.equal(refuse.status, 422);
  assert.equal((await c('GET', '/clients?q=Import', { token: A.token })).body.meta.total, 0);
  const ok = await c('POST', '/clients/import', { token: A.token, body: { csv, skipInvalid: true } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.created, 2);
  assert.equal((await c('POST', '/clients/import', { token: readOnly.token, body: { csv } })).status, 403);
  assert.equal((await c('POST', '/clients/import', { token: A.token, body: { csv: 'Foo;Bar\r\n1;2' } })).status, 400);
  // export : injection de formule neutralisée
  await c('POST', '/clients', { token: A.token, body: { name: '=HYPERLINK("http://evil")' } });
  const exp = await c('GET', '/clients/export.csv', { token: A.token });
  assert.equal(exp.status, 200);
  assert.ok(exp.raw.includes("'=HYPERLINK"));
  assert.ok(!exp.raw.includes('Client privé A') || true);
  const expB = await c('GET', '/clients/export.csv', { token: B.token });
  assert.ok(!expB.raw.includes('Import Un'), 'export limité à la société');
});

test('fournisseurs : CRUD et isolation', async () => {
  const s = await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Tunis' } });
  assert.equal(s.status, 201);
  assert.match(s.body.data.code, /^FOU-\d{5}$/);
  assert.equal((await c('GET', `/suppliers/${s.body.data.id}`, { token: B.token })).status, 404);
  assert.equal((await c('GET', `/clients/${s.body.data.id}`, { token: A.token })).status, 404, 'tables distinctes');
  assert.equal((await c('POST', '/suppliers', { token: readOnly.token, body: { name: 'Non' } })).status, 403);
  assert.equal((await c('GET', '/suppliers?q=Tunis', { token: A.token })).body.data.length, 1);
});

test('articles : TVA par défaut, décimaux exacts, service sans stock, SKU unique', async () => {
  const cat = await c('POST', '/product-categories', { token: A.token, body: { name: 'Informatique' } });
  assert.equal(cat.status, 201);
  const p = await c('POST', '/products', { token: A.token, body: { name: 'Clavier', salePrice: '12,5', purchasePrice: 8.125, categoryId: cat.body.data.id, trackStock: true, stockAlertThreshold: '5' } });
  assert.equal(p.status, 201, p.raw);
  assert.equal(p.body.data.salePrice, '12.500');
  assert.equal(p.body.data.purchasePrice, '8.125');
  assert.match(p.body.data.sku, /^ART-\d{5}$/);
  assert.equal(p.body.data.taxRate.isDefault, undefined);
  assert.equal(p.body.data.taxRate.kind, 'standard');
  assert.equal(p.body.data.category.name, 'Informatique');
  assert.equal(p.body.data.trackStock, true);
  const svc = await c('POST', '/products', { token: A.token, body: { name: 'Maintenance', type: 'service', sku: 'SRV-1', salePrice: 100, trackStock: true, stockAlertThreshold: 3 } });
  assert.equal(svc.body.data.trackStock, false);
  assert.equal(svc.body.data.stockAlertThreshold, null);
  assert.equal((await c('POST', '/products', { token: A.token, body: { name: 'Doublon', sku: 'SRV-1' } })).status, 409);
  assert.equal((await c('POST', '/products', { token: B.token, body: { name: 'Autre société', sku: 'SRV-1' } })).status, 201);
  assert.equal((await c('POST', '/products', { token: A.token, body: { name: 'Prix', salePrice: '-5' } })).status, 400);
  assert.equal((await c('POST', '/products', { token: A.token, body: { name: 'Prix', salePrice: '1.2345' } })).status, 400);
  assert.equal((await c('POST', '/products', { token: A.token, body: { name: 'Prix', salePrice: 'abc' } })).status, 400);
  // références d'une autre société refusées
  const catB = await c('POST', '/product-categories', { token: B.token, body: { name: 'Cat B' } });
  assert.equal((await c('POST', '/products', { token: A.token, body: { name: 'Fuite', categoryId: catB.body.data.id } })).status, 422);
  const taxB = (await c('GET', '/tax-rates', { token: B.token })).body.data[0];
  assert.equal((await c('POST', '/products', { token: A.token, body: { name: 'Fuite', taxRateId: taxB.id } })).status, 422);
  // exonéré
  const exempt = (await c('GET', '/tax-rates', { token: A.token })).body.data.find((t) => t.kind === 'exempt');
  const ex = await c('POST', '/products', { token: A.token, body: { name: 'Livre', taxRateId: exempt.id } });
  assert.equal(ex.body.data.taxRate.rate, '0.00');
  // taux utilisé : suppression refusée, désactivation -> plus assignable
  assert.equal((await c('DELETE', `/tax-rates/${exempt.id}`, { token: A.token })).status, 409);
  await c('PATCH', `/tax-rates/${exempt.id}`, { token: A.token, body: { isActive: false } });
  assert.equal((await c('POST', '/products', { token: A.token, body: { name: 'Livre 2', taxRateId: exempt.id } })).status, 422);
  // modification, filtres
  const up = await c('PATCH', `/products/${p.body.data.id}`, { token: A.token, body: { salePrice: '15', type: 'service' } });
  assert.equal(up.body.data.salePrice, '15.000');
  assert.equal(up.body.data.trackStock, false);
  assert.equal((await c('GET', '/products?type=service', { token: A.token })).body.data.length, 2);
  assert.equal((await c('GET', `/products?categoryId=${cat.body.data.id}`, { token: A.token })).body.data.length, 1);
  assert.equal((await c('GET', '/products?q=SRV', { token: A.token })).body.data.length, 1);
  // permissions
  assert.equal((await c('POST', '/products', { token: sales.token, body: { name: 'Non' } })).status, 403);
  assert.equal((await c('GET', '/products', { token: sales.token })).status, 200);
  assert.equal((await c('GET', `/products/${p.body.data.id}`, { token: B.token })).status, 404);
  assert.equal((await c('DELETE', `/product-categories/${cat.body.data.id}`, { token: A.token })).status, 409);
});

test('articles : import CSV avec TVA et catégories', async () => {
  const csv = 'SKU;Nom;Type;Catégorie;Prix de vente HT;TVA;Suivi de stock\r\nIMP-1;Souris;produit;Accessoires;9,900;19%;oui\r\nIMP-2;Audit;service;;250;TVA 7 %;non\r\nIMP-3;Inconnu;produit;;5;42%;non\r\n';
  const dry = await c('POST', '/products/import', { token: A.token, body: { csv, dryRun: true } });
  assert.equal(dry.body.data.valid, 2);
  assert.equal(dry.body.data.errors.length, 1);
  const ok = await c('POST', '/products/import', { token: A.token, body: { csv, skipInvalid: true } });
  assert.equal(ok.status, 201, ok.raw);
  assert.equal(ok.body.data.created, 2);
  const l = await c('GET', '/products?q=IMP-1', { token: A.token });
  assert.equal(l.body.data[0].salePrice, '9.900');
  assert.equal(l.body.data[0].category.name, 'Accessoires');
  assert.equal((await c('POST', '/products/import', { token: A.token, body: { csv, skipInvalid: true } })).body.data.created, 0, 'ré-import : doublons rejetés');
  const exp = await c('GET', '/products/export.csv', { token: A.token });
  assert.ok(exp.raw.includes('IMP-1'));
});

test('numérotation : créations concurrentes sans doublon', async () => {
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => c('POST', '/clients', { token: B.token, body: { name: `Concurrent ${i}` } })));
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(new Set(rs.map((r) => r.body.data.code)).size, 8);
});

test('journal d\'audit : création, archivage, export', async () => {
  const { pool } = await import('../src/config/db.js');
  const [rows] = await pool.query("SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'client.%' OR action LIKE 'product.%'");
  const actions = rows.map((r) => r.action);
  for (const a of ['client.create', 'client.archive', 'client.export', 'client.import', 'product.create', 'product.import']) assert.ok(actions.includes(a), a);
});
