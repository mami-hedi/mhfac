import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';
import { buildNumber, configOf, DOC_TYPES } from '../src/core/numbering.js';

let app, A, B, readOnly, cli;
const c = (...a) => app.call(...a);
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date()); const year = today.slice(0, 4);
const getCfg = async (token = A.token) => ok(await c('GET', '/companies/current/numbering', { token }));
const put = (items, token = A.token) => c('PUT', '/companies/current/numbering', { token, body: { items } });
const one = (cfg, docType = 'quote') => ({ docType, prefix: 'DEV', separator: '-', includeYear: true, yearlyReset: true, width: 5, ...cfg });
const quote = async (token = A.token, clientId = cli.id) => ok(await c('POST', '/quotes', { token, body: { clientId, issueDate: today, lines: [{ description: 'Prestation', quantity: 1, unitPrice: '100' }] } }), 201);

before(async () => {
  app = await startApp(); A = await registerCompany(app.call, 'Num A'); B = await registerCompany(app.call, 'Num B'); readOnly = await addMember(app.call, A, 'read_only');
  cli = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Num' } }), 201);
});
after(() => app.close());

test('format : construction pure (préfixe, séparateur, année, largeur)', () => {
  assert.equal(buildNumber(configOf('invoice'), '2026', 1), 'FAC-2026-00001');
  assert.equal(buildNumber({ prefix: 'F', separator: '/', includeYear: true, width: 3 }, '2026', 42), 'F/2026/042');
  assert.equal(buildNumber({ prefix: 'BL', separator: '', includeYear: false, width: 4 }, '2026', 7), 'BL0007');
  assert.equal(buildNumber({ prefix: 'BC', separator: '.', includeYear: false, width: 6 }, '2027', 123456), 'BC.123456');
  assert.equal(Object.keys(DOC_TYPES).length, 20);
});

test('par défaut : format historique conservé (DEV-AAAA-00001) et 20 types listés', async () => {
  const d = await getCfg(); assert.equal(d.items.length, 20);
  const q = d.items.find((i) => i.docType === 'quote'); assert.deepEqual([q.prefix, q.separator, q.includeYear, q.yearlyReset, q.width, q.nextNumber], ['DEV', '-', true, true, 5, 1]);
  assert.equal(q.example, `DEV-${year}-00001`);
  const first = await quote(); assert.equal(first.number, `DEV-${year}-00001`);
  assert.equal((await getCfg()).items.find((i) => i.docType === 'quote').nextNumber, 2);
});

test('personnalisation : préfixe libre, séparateur, largeur ; seuls les NOUVEAUX documents changent', async () => {
  const before_ = await quote(); // DEV-AAAA-00002
  ok(await put([one({ prefix: 'dv', separator: '/', width: 3 })]));
  const q = await quote(); assert.equal(q.number, `DV/${year}/003`, 'le compteur continue, le format change');
  assert.equal(ok(await c('GET', `/quotes/${before_.id}`, { token: A.token })).number, before_.number, 'un numéro attribué ne change jamais');
  // le nom du fichier PDF ne contient jamais de « / »
  const res = await fetch(`${app.base}/quotes/${q.id}/pdf`, { headers: { authorization: `Bearer ${A.token}` } });
  assert.equal(res.status, 200); const cd = res.headers.get('content-disposition'); assert.match(cd, /filename="[A-Za-z0-9._-]+\.pdf"/); assert.ok(!/filename="[^"]*\//.test(cd));
  // sans année, sans séparateur : continu
  ok(await put([one({ prefix: 'D', separator: '', includeYear: false, yearlyReset: false, width: 4 })]));
  const q2 = await quote(); assert.match(q2.number, /^D\d{4}$/); assert.equal(Number(q2.number.slice(1)) > 3, true, 'numérotation continue : repart au plus haut numéro déjà utilisé (aucun doublon)');
  // retour à la remise à zéro annuelle : repart au plus haut numéro, pas à 1
  ok(await put([one({ prefix: 'DEV' })]));
  const q3 = await quote(); assert.ok(Number(q3.number.split('-').pop()) > Number(q2.number.slice(1)), q3.number);
});

test('prochain numéro : peut augmenter (reprise d\'une numérotation existante), jamais diminuer', async () => {
  const cur = (await getCfg()).items.find((i) => i.docType === 'quote').nextNumber;
  const r = await put([one({ nextNumber: cur - 1 })]); assert.equal(r.status, 400); assert.equal(r.body.error.code, 'COUNTER_LOWER');
  ok(await put([one({ nextNumber: 150 })]));
  assert.equal((await quote()).number, `DEV-${year}-00150`); assert.equal((await quote()).number, `DEV-${year}-00151`);
  // inchangé si on renvoie la même valeur
  const n = (await getCfg()).items.find((i) => i.docType === 'quote').nextNumber; ok(await put([one({ nextNumber: n })])); assert.equal((await quote()).number, `DEV-${year}-${String(n).padStart(5, '0')}`);
});

test('facture : le numéro est attribué à l\'émission avec le modèle choisi ; avoir distinct', async () => {
  ok(await put([one({ docType: 'invoice', prefix: 'F', separator: '/', width: 4 }), one({ docType: 'credit_note', prefix: 'AV', separator: '/', width: 4 })]));
  const inv = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: cli.id, issueDate: today, lines: [{ description: 'Prestation', quantity: 1, unitPrice: '100' }] } }), 201);
  assert.equal(inv.number ?? null, null, 'brouillon sans numéro');
  const issued = ok(await c('POST', `/invoices/${inv.id}/issue`, { token: A.token })); assert.equal(issued.number, `F/${year}/0001`);
  assert.equal((await fetch(`${app.base}/invoices/${inv.id}/pdf`, { headers: { authorization: `Bearer ${A.token}` } })).status, 200);
});

test('validation : préfixe, largeur, année obligatoire avec remise à zéro, préfixe unique, droits, isolation', async () => {
  for (const bad of [{ prefix: 'A B' }, { prefix: '' }, { prefix: 'ABCDEFGHIJK' }, { prefix: 'é' }, { width: 2 }, { width: 9 }, { separator: '#' }, { includeYear: false, yearlyReset: true }, { nextNumber: 0 }]) {
    assert.equal((await put([one(bad)])).status, 400, JSON.stringify(bad));
  }
  assert.equal((await put([one({ docType: 'nope' })])).status, 400);
  assert.equal((await put([one({}), one({})])).status, 400, 'type en double');
  // deux types ne peuvent pas partager un préfixe (pas deux fois « BC »)
  assert.equal((await put([one({ docType: 'sales_order', prefix: 'BC' })])).status, 200);
  const dup = await put([one({ docType: 'purchase_order', prefix: 'bc' })]); assert.equal(dup.status, 400); assert.equal(dup.body.error.code, 'PREFIX_DUPLICATE'); assert.match(dup.body.error.message, /Bon de commande client/);
  assert.equal((await put([one({ docType: 'quote', prefix: 'f' })])).status, 400, 'F est déjà pris par la facture de vente (insensible à la casse)');
  // droits
  assert.equal((await put([one({})], readOnly.token)).status, 403); assert.equal((await c('GET', '/companies/current/numbering', { token: readOnly.token })).status, 403, 'lecture seule : pas d\'accès aux réglages');
  assert.equal((await c('GET', '/companies/current/numbering')).status, 401);
  // isolation : B garde les valeurs par défaut et ses propres compteurs
  const b = await getCfg(B.token); assert.equal(b.items.find((i) => i.docType === 'sales_order').prefix, 'CMD'); assert.equal(b.items.find((i) => i.docType === 'quote').nextNumber, 1);
  const cliB = ok(await c('POST', '/clients', { token: B.token, body: { name: 'Client B' } }), 201); assert.equal((await quote(B.token, cliB.id)).number, `DEV-${year}-00001`);
  // le formulaire général des réglages ne peut pas contourner la validation
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { numbering: { quote: { prefix: 'ZZ' } } } })).status, 400);
  assert.equal((await getCfg()).items.find((i) => i.docType === 'sales_order').prefix, 'BC');
});
