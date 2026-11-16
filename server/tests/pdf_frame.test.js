import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, readOnly;
const c = (...a) => app.call(...a);
const patch = (token, body) => c('PATCH', '/companies/current/settings', { token, body });
const get = async (token) => (await c('GET', '/companies/current/settings', { token })).body.data;
const HEADERS = ['classic', 'centered', 'band', 'minimal', 'custom']; const FOOTERS = ['classic', 'columns', 'minimal', 'custom'];
const sample = async (body, token = A.token) => { const r = await fetch(`${app.base}/sales/sample-pdf`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; };
// Texte extrait du PDF (pdftotext) — ignoré si l'outil n'est pas installé.
const textOf = (buf) => { const d = mkdtempSync(path.join(tmpdir(), 'pdf-')); try { const f = path.join(d, 'a.pdf'); writeFileSync(f, buf); const r = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; } finally { rmSync(d, { recursive: true, force: true }); } };

before(async () => { app = await startApp(); A = await registerCompany(app.call, 'Cadre A'); B = await registerCompany(app.call, 'Cadre B'); readOnly = await addMember(app.call, A, 'read_only'); });
after(() => app.close());

test('modèles d\'en-tête × pied de page : tous produisent un PDF valide (3 types de documents)', async () => {
  for (const headerStyle of HEADERS) for (const footerStyle of FOOTERS) for (const kind of ['invoice', 'quote', 'delivery_note']) {
    const r = await sample({ kind, accentColor: '#0f766e', branding: { headerStyle, footerStyle, headerText: 'Atelier Test\nZone 1', footerText: 'Pied perso' } });
    assert.equal(r.status, 200, `${headerStyle}/${footerStyle}/${kind}`); assert.equal(r.buf.subarray(0, 5).toString(), '%PDF-');
  }
  // couleur très claire : le bandeau reste lisible (texte sombre) sans erreur
  assert.equal((await sample({ branding: { headerStyle: 'band' }, accentColor: '#fde68a' })).status, 200);
});

test('modèle personnalisé : le texte saisi apparaît, alignement, numéro de page optionnel, repli sur l\'identité si vide', async () => {
  const r = await sample({ branding: { headerStyle: 'custom', headerText: 'Zorglub Industries\nBP 42 Nabeul', headerAlign: 'right', showLogo: false, footerStyle: 'custom', footerText: 'Capital 5000 DT - IBAN XYZ-123', footerAlign: 'left', showPageNumber: false } });
  assert.equal(r.status, 200);
  const t = textOf(r.buf);
  if (t !== null) {
    assert.match(t, /Zorglub Industries/); assert.match(t, /BP 42 Nabeul/); assert.match(t, /Capital 5000 DT - IBAN XYZ-123/); assert.doesNotMatch(t, /Page 1\/1/, 'numéro de page masqué');
    const base = textOf((await sample({ branding: { footerStyle: 'custom', footerText: 'Mon pied', showPageNumber: true } })).buf); assert.match(base, /Mon pied/); assert.match(base, /Page 1\/1/);
    const empty = textOf((await sample({ branding: { headerStyle: 'custom', headerText: '', footerStyle: 'custom', footerText: '' } })).buf); assert.match(empty, /Cadre A/, 'texte vide : identité de l\'entreprise');
    const cols = textOf((await sample({ branding: { footerStyle: 'columns' } })).buf); assert.match(cols, /Page 1\/1/);
  }
  // texte démesuré : tronqué proprement, le PDF reste valide et sur une page
  const long = await sample({ branding: { headerStyle: 'custom', headerText: `${'Très long titre '.repeat(20)}\n${'x '.repeat(120)}`, footerStyle: 'custom', footerText: 'Ligne\n'.repeat(3) + 'mot '.repeat(60) } });
  assert.equal(long.status, 200);
});

test('réglages : enregistrement, relecture, valeurs par défaut des anciennes entreprises, validation, droits et isolation', async () => {
  const s0 = await get(A.token); assert.equal(s0.branding.headerStyle, 'classic'); assert.equal(s0.branding.footerStyle, 'classic'); assert.equal(s0.branding.showPageNumber, true);
  const body = { branding: { headerStyle: 'custom', headerText: 'Cabinet Z\r\n\u0007Ligne 2', headerAlign: 'center', showLogo: false, footerStyle: 'custom', footerText: 'Pied personnalisé', footerAlign: 'right', showPageNumber: false } };
  assert.equal((await patch(A.token, body)).status, 200);
  const s = await get(A.token);
  assert.equal(s.branding.headerStyle, 'custom'); assert.equal(s.branding.headerText, 'Cabinet Z\nLigne 2', 'retours chariot et caractères de contrôle retirés'); assert.equal(s.branding.showLogo, false); assert.equal(s.branding.footerAlign, 'right'); assert.equal(s.branding.showPageNumber, false);
  // les autres réglages ne sont pas écrasés
  assert.equal((await patch(A.token, { branding: { accentColor: '#ff0000' } })).status, 200); assert.equal((await get(A.token)).branding.headerStyle, 'custom');
  // validation
  assert.equal((await patch(A.token, { branding: { headerStyle: 'rainbow' } })).status, 400);
  assert.equal((await patch(A.token, { branding: { footerStyle: 'x' } })).status, 400);
  assert.equal((await patch(A.token, { branding: { footerAlign: 'top' } })).status, 400);
  assert.equal((await patch(A.token, { branding: { headerText: 'a'.repeat(601) } })).status, 400);
  assert.equal((await patch(A.token, { branding: { footerText: 'a'.repeat(401) } })).status, 400);
  // droits et isolation
  assert.equal((await patch(readOnly.token, { branding: { headerStyle: 'band' } })).status, 403);
  const sb = await get(B.token); assert.equal(sb.branding.headerStyle, 'classic'); assert.equal(sb.branding.headerText, '');
  // le vrai PDF d'une facture suit le modèle enregistré (document réel, pas seulement l'aperçu)
  assert.equal((await sample({ kind: 'invoice' }, B.token)).status, 200);
  assert.equal((await sample({ branding: { headerStyle: 'nope' } })).status, 400);
  assert.equal((await fetch(`${app.base}/sales/sample-pdf`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});
