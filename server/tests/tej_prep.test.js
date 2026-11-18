import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';
import { checkRow, MF_RE } from '../src/modules/withholdings/tej-prep.js';
import { cleanText, buildTejXml, fileName } from '../src/modules/withholdings/tej-xml.js';
import path from 'node:path';

let app, A, B, readOnly, sup, supNoId, tax19;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const month = today.slice(0, 7);
before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'TEJ A'); B = await registerCompany(app.call, 'TEJ B'); readOnly = await addMember(app.call, A, 'read_only');
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Société Équipement & Co', taxId: '1234567A', address: '12 rue de l\'été, Tunis', email: 'contact@equipement.tn', phone: '71000000', type: 'company', country: 'TN' } }), 201);
  supNoId = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur sans MF' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
});
after(() => app.close());

test('contrôles purs : matricule fiscal, totaux, date de paiement', () => {
  assert.ok(MF_RE.test('1234567A')); assert.ok(!MF_RE.test('123456A'));
  const base = { supplierName: 'X', taxId: '1234567A', paymentDate: '2026-11-02', totalHt: '1000.000', totalTax: '190.000', totalTtc: '1190.000', stampDuty: '0', amount: '17.850' };
  assert.deepEqual(checkRow(base), []);
  assert.ok(checkRow({ ...base, taxId: null }).some((i) => i.code === 'TAXID_MISSING'));
  assert.equal(checkRow({ ...base, taxId: 'AB12' })[0].level, 'warning');
  assert.ok(checkRow({ ...base, paymentDate: null }).some((i) => i.code === 'PAYMENT_DATE_MISSING'));
  assert.ok(checkRow({ ...base, totalTax: '100.000' }).some((i) => i.code === 'TOTALS_MISMATCH'));
});


test('texte TEJ : accents et caractères interdits retirés, nom de fichier', () => {
  assert.equal(cleanText("Société Équipement & Co -- /* x */ 'OR 1=1"), "Societe Equipement Co x OR 1 1"); assert.equal(cleanText("Or et Argent"), "Or et Argent");
  assert.ok(!/[éèàç&;*]|--|\/\*|&#|'\s*(or|and)\b/i.test(cleanText("Café; R&D -- a /* b */ 'OR 'and x")));
  assert.equal(fileName('0001238l', 2024, '01', 0), '0001238L-2024-01-0.xml');
});

test('préparation TEJ : contrôles, code d\'opération, XML bloqué sans XSD puis valide contre les XSD officiels TEJ', async () => {
  const mk = async (supplierId, ref) => { const p = ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId, issueDate: today, supplierRef: ref, withholdingPct: '1.5', lines: [{ description: 'Prestation', quantity: 1, unitPrice: '1000', taxRateId: tax19.id }] } }), 201); ok(await c('POST', `/purchase-invoices/${p.id}/record`, { token: A.token })); return p; };
  const p1 = await mk(sup.id, 'F-TEJ-1'); const p2 = await mk(supNoId.id, 'F-TEJ-2'); await mk(sup.id, 'F-TEJ-3'); // p3 non payée
  const num = async (p) => ok(await c('GET', `/purchase-invoices/${p.id}`, { token: A.token })).number; const n1 = await num(p1); const n2 = await num(p2);
  ok(await c('POST', '/supplier-payments', { token: A.token, body: { supplierId: sup.id, date: today, method: 'bank_transfer', allocations: [{ invoiceId: p1.id, amount: '1172.150' }] } }), 201);
  ok(await c('POST', '/supplier-payments', { token: A.token, body: { supplierId: supNoId.id, date: today, method: 'bank_transfer', allocations: [{ invoiceId: p2.id, amount: '100' }] } }), 201);
  const get = async (token = A.token) => c('GET', `/withholdings/purchases/tej-prep?month=${month}`, { token });
  let r = await get(); assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.data.length, 2, 'la facture non payée est exclue'); assert.match(r.body.meta.notice, /pas le fichier XML officiel/);
  const row = (ref) => r.body.data.find((d) => d.invoice === ref); const codes = (ref) => row(ref).issues.map((i) => i.code);
  assert.ok(codes(n1).includes('OPERATION_CODE_MISSING')); assert.ok(codes(n2).includes('BENEFICIARY_ID')); assert.ok(codes(n2).includes('PARTIAL_PAYMENT'));
  assert.equal(row(n1).retenue, '17850'); assert.equal(row(n1).ht, '1000000'); assert.equal(row(n1).tva, '190000');
  // 409 : XSD officiels absents
  process.env.TEJ_XSD_DIR = path.resolve('tests/fixtures/__absent__');
  assert.equal((await c('GET', `/withholdings/purchases/tej-prep/xml?month=${month}`, { token: A.token })).status, 409);
  // choix du code : RS7_000001 (1,5 %) ; un code au mauvais taux est signalé
  assert.equal((await c('PUT', `/withholdings/purchases/${p1.id}/tej-operation`, { token: A.token, body: { operationCode: 'RS9999' } })).status, 400);
  assert.equal((await c('PUT', `/withholdings/purchases/${p1.id}/tej-operation`, { token: readOnly.token, body: { operationCode: 'RS7_000001' } })).status, 403);
  ok(await c('PUT', `/withholdings/purchases/${p2.id}/tej-operation`, { token: A.token, body: { operationCode: 'RS2_000002' } }));
  r = await get(); assert.ok(codes(n2).includes('RATE_MISMATCH'));
  assert.equal(ok(await c('PUT', `/withholdings/purchases/${p1.id}/tej-operation`, { token: A.token, body: { operationCode: 'RS7_000001' } })).rateMatches, true);
  r = await get(); assert.deepEqual(codes(n1), []); assert.equal(row(n1).operationCode, 'RS7_000001');
  assert.equal(ok(await c('GET', '/withholdings/tej/codes', { token: A.token })).find((x) => x.code === 'RS7_000001').rate, '1.50');
  // XSD officiels présents mais facture en erreur -> 422 avec le détail ; entreprise sans matricule -> 422
  process.env.TEJ_XSD_DIR = path.resolve('schemas/tej');
  assert.equal((await c('GET', `/withholdings/purchases/tej-prep/xml?month=${month}`, { token: A.token })).status, 422);
  // on ne garde que p1 : on annule p2 dans le périmètre en corrigeant son fournisseur et son code
  ok(await c('PUT', `/withholdings/purchases/${p2.id}/tej-operation`, { token: A.token, body: { operationCode: 'RS7_000001' } }));
  ok(await c('PATCH', `/suppliers/${supNoId.id}`, { token: A.token, body: { name: 'Fournisseur sans MF', taxId: '7654321B', address: 'Sousse', email: 'f@sans.tn', phone: '73000000', type: 'individual', country: 'TN' } }));
  ok(await c('POST', '/supplier-payments', { token: A.token, body: { supplierId: supNoId.id, date: today, method: 'bank_transfer', allocations: [{ invoiceId: p2.id, amount: '1072.150' }] } }), 201);
  const noMf = await c('GET', `/withholdings/purchases/tej-prep/xml?month=${month}`, { token: A.token }); assert.equal(noMf.status, 422); assert.equal(noMf.body.error.code, 'DECLARANT_TAXID');
  ok(await c('PATCH', '/companies/current', { token: A.token, body: { taxId: '0001238L' } }));
  const raw = await fetch(`${app.base}/withholdings/purchases/tej-prep/xml?month=${month}`, { headers: { authorization: `Bearer ${A.token}` } }); const xml = await raw.text();
  assert.equal(raw.status, 200, xml); assert.match(raw.headers.get('content-disposition'), new RegExp(`0001238L-${month.slice(0, 4)}-${month.slice(5)}-0\\.xml`));
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')); assert.ok(!xml.includes('<!--')); assert.ok(xml.includes('IdTypeOperation="RS7_000001"')); assert.ok(xml.includes('<MontantRS>17850</MontantRS>')); assert.ok(xml.includes('<DatePayement>'));
  assert.ok(xml.includes('Societe Equipement Co') && !/[éèà&;]/.test(xml.replace(/&amp;|&lt;|&gt;/g, '').replace(/xmlns:xsi="[^"]*"/, '')), 'texte nettoyé');
  // le XML est contrôlé contre le schéma : un XML cassé est refusé par le validateur
  const { validateAgainstXsd, loadXsd } = await import('../src/modules/withholdings/tej-xml.js');
  assert.equal((await validateAgainstXsd(xml, loadXsd())).valid, true);
  assert.equal((await validateAgainstXsd(xml.replace('<MontantHT>', '<MontantHT>abc'), loadXsd())).valid, false);
  assert.equal((await validateAgainstXsd(xml.replace('0001238L', '123'), loadXsd())).valid, false);
  // CSV, droits, isolation
  const csvRes = await fetch(`${app.base}/withholdings/purchases/tej-prep/export?month=${month}`, { headers: { authorization: `Bearer ${A.token}` } }); const buf = Buffer.from(await csvRes.arrayBuffer());
  assert.equal(csvRes.status, 200); assert.ok(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))); assert.ok(buf.toString('utf8').includes('17850'));
  assert.equal((await get(readOnly.token)).status, 200); assert.equal((await c('GET', `/withholdings/purchases/tej-prep/xml?month=${month}`, { token: B.token })).status, 422, 'isolation : B n\'a rien à exporter');
  assert.equal((await c('GET', '/withholdings/purchases/tej-prep?month=2026-13', { token: A.token })).status, 400);
  assert.equal((await fetch(`${app.base}/withholdings/purchases/tej-prep/xml?month=${month}`)).status, 401);
  delete process.env.TEJ_XSD_DIR;
});

test('codes d\'opération TEJ : chaque code du code source existe dans le XSD officiel', async () => {
  const fs = await import('node:fs'); const xsd = fs.readFileSync(path.resolve('schemas/tej/TEJRSCodesOperations_v1.0.xsd'), 'utf8');
  const official = new Set([...xsd.matchAll(/enumeration value="(RS\d+_\d+)"/g)].map((m) => m[1]));
  const { OPERATION_CODES } = await import('../src/modules/withholdings/tej-codes.js');
  for (const code of Object.keys(OPERATION_CODES)) assert.ok(official.has(code), `${code} absent du XSD officiel`);
  assert.ok(official.size >= 40);
});

test('matricule fiscal : la forme complète 1654872X/A/M/000 est acceptée et réduite à 1654872X (XSD TEJ) ; les formes invalides restent refusées', async () => {
  const { normalizeMf, isMf } = await import('../src/modules/withholdings/tej-xml.js');
  for (const ok of ['1654872X/A/M/000', '1654872X', '1654872 X', '1654872-x', '1654872X/N/N/000', '1654872X/B/P/000']) { assert.equal(normalizeMf(ok), '1654872X', ok); assert.equal(isMf(ok), true, ok); }
  for (const bad of ['', null, '165487X', '16548723', '1654872', '1654872XYZ99', '12345678', 'AB12345', '1654872X/A/M/00']) assert.equal(isMf(bad), false, String(bad));
});
