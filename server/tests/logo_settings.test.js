import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, readOnly;
const c = (...a) => app.call(...a);
const patch = (token, body) => c('PATCH', '/companies/current/settings', { token, body });
const get = async (token) => (await c('GET', '/companies/current/settings', { token })).body.data;
// PNG 1x1 réel et JPEG minimal (en-tête valide) : suffisent pour tester la validation des octets
const PNG = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex').toString('base64')}`;
const JPG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]).toString('base64')}`;

before(async () => { app = await startApp(); A = await registerCompany(app.call, 'Logo A'); B = await registerCompany(app.call, 'Logo B'); readOnly = await addMember(app.call, A, 'read_only'); });
after(() => app.close());

test('logo : enregistré, relu, et conservé quand on modifie d\'autres paramètres', async () => {
  assert.equal((await patch(A.token, { branding: { logo: PNG } })).status, 200);
  assert.equal((await get(A.token)).branding.logo, PNG);
  // un enregistrement ultérieur du formulaire fiscal / de la couleur ne doit JAMAIS effacer le logo
  assert.equal((await patch(A.token, { sales: { quoteValidityDays: 20 } })).status, 200);
  assert.equal((await patch(A.token, { branding: { accentColor: '#ff0000', template: 'modern' } })).status, 200);
  const s = await get(A.token);
  assert.equal(s.branding.logo, PNG); assert.equal(s.branding.accentColor, '#ff0000'); assert.equal(s.branding.template, 'modern'); assert.equal(s.sales.quoteValidityDays, 20);
  assert.equal((await patch(A.token, { branding: { logo: JPG } })).status, 200); assert.equal((await get(A.token)).branding.logo, JPG);
});

test('logo : retrait explicite, et isolation entre entreprises', async () => {
  assert.equal((await get(B.token)).branding.logo, null, 'le logo de A n\'apparaît pas chez B');
  assert.equal((await patch(A.token, { branding: { logo: null } })).status, 200);
  assert.equal((await get(A.token)).branding.logo, null);
  assert.equal((await get(A.token)).branding.accentColor, '#ff0000', 'retirer le logo ne touche pas la couleur');
});

test('logo : fichier non image, type trompeur, trop gros, et droits', async () => {
  const html = `data:image/png;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`;
  const r = await patch(A.token, { branding: { logo: html } }); assert.equal(r.status, 400, 'HTML déguisé en PNG');
  assert.equal((await patch(A.token, { branding: { logo: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` } })).status, 400);
  assert.equal((await patch(A.token, { branding: { logo: `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(320_000)]).toString('base64')}` } })).status, 400, 'plus de 400 000 caractères');
  assert.equal((await patch(readOnly.token, { branding: { logo: PNG } })).status, 403);
  assert.equal((await get(A.token)).branding.logo, null, 'aucun refus n\'a modifié le logo');
});
