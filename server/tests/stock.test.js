import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';
import { pool } from '../src/config/db.js';

let app, A, B, readOnly, sales, client, tax19, wh1, wh2, prod, plain;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const entry = (productId, quantity, unitCost, extra = {}) => ({ warehouseId: wh1.id, date: today, lines: [{ productId, quantity, unitCost }], ...extra });
const level = async (p = prod, wh = null) => {
  const r = await c('GET', `/stock/levels?q=${encodeURIComponent(p.name)}${wh ? `&warehouseId=${wh.id}` : ''}`, { token: A.token });
  return r.body.data.find((x) => x.productId === p.id);
};
const mkVoucher = async (kind, body) => { const r = await c('POST', `/stock/${kind}`, { token: A.token, body }); assert.equal(r.status, 201, r.raw); return r.body.data; };
const validate = (kind, id, token = A.token) => c('POST', `/stock/${kind}/${id}/validate`, { token });
const movementsOf = async (source) => (await pool.query('SELECT * FROM stock_movements WHERE source_id = ?', [source]))[0];

before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Stock A'); B = await registerCompany(app.call, 'Stock B');
  assert.equal((await c('GET', '/companies/current/settings', { token: A.token })).body.data.stock.allowNegative, true, 'défaut : stock négatif autorisé');
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { stock: { allowNegative: false } } }); // les tests de refus supposent l'option désactivée
  readOnly = await addMember(app.call, A, 'read_only'); sales = await addMember(app.call, A, 'sales');
  client = (await c('POST', '/clients', { token: A.token, body: { name: 'Client Stock' } })).body.data;
  tax19 = (await c('GET', '/tax-rates', { token: A.token })).body.data.find((t) => t.rate === '19.00');
  prod = (await c('POST', '/products', { token: A.token, body: { name: 'Écran 24 pouces', salePrice: '300', taxRateId: tax19.id, trackStock: true, stockAlertThreshold: '5' } })).body.data;
  plain = (await c('POST', '/products', { token: A.token, body: { name: 'Câble non suivi', salePrice: '10', taxRateId: tax19.id } })).body.data;
  const ws = (await c('GET', '/stock/warehouses', { token: A.token })).body.data;
  wh1 = ws[0];
});
after(() => app.close());

test('entrepôts : principal créé automatiquement, code unique, un seul par défaut, droits', async () => {
  assert.equal(wh1.isDefault, true); assert.equal(wh1.code, 'PRINC');
  const r = await c('POST', '/stock/warehouses', { token: A.token, body: { code: 'sfax', name: 'Dépôt Sfax' } });
  assert.equal(r.status, 201, r.raw); wh2 = r.body.data; assert.equal(wh2.code, 'SFAX'); assert.equal(wh2.isDefault, false);
  assert.equal((await c('POST', '/stock/warehouses', { token: A.token, body: { code: 'SFAX', name: 'Doublon' } })).status, 409);
  assert.equal((await c('POST', '/stock/warehouses', { token: readOnly.token, body: { code: 'XX1', name: 'Interdit' } })).status, 403);
  assert.equal((await c('GET', '/stock/warehouses', { token: readOnly.token })).status, 200);
  assert.equal((await c('GET', '/stock/warehouses', { token: B.token })).body.data.length, 1, 'chaque société a ses propres entrepôts');
});

test('bon d\'entrée : coût moyen pondéré, brouillon sans effet, validation idempotente', async () => {
  const v = await mkVoucher('entries', entry(prod.id, 10, '100'));
  assert.equal(v.status, 'draft'); assert.equal(v.number, null);
  assert.equal((await level()).quantity, '0.0000', 'un brouillon ne bouge pas le stock');
  const ok = await validate('entries', v.id);
  assert.equal(ok.status, 200, ok.raw); assert.match(ok.body.data.number, /^BEN-\d{4}-\d{5}$/);
  let l = await level(); assert.equal(l.quantity, '10.0000'); assert.equal(l.avgCost, '100.0000');
  assert.equal((await validate('entries', v.id)).status, 409, 'deuxième validation refusée');
  assert.equal((await movementsOf(v.id)).length, 1, 'un seul mouvement');
  const v2 = await mkVoucher('entries', entry(prod.id, 10, '120')); await validate('entries', v2.id);
  l = await level(); assert.equal(l.quantity, '20.0000'); assert.equal(l.avgCost, '110.0000'); assert.equal(l.value, '2200.000');
  // lecture seule et même société uniquement
  assert.equal((await c('GET', `/stock/entries/${v.id}`, { token: B.token })).status, 404);
  assert.equal((await validate('entries', (await mkVoucher('entries', entry(prod.id, 1, '1'))).id, readOnly.token)).status, 403);
});

test('validations concurrentes du même bon : un seul mouvement', async () => {
  const v = await mkVoucher('entries', entry(prod.id, 3, '110'));
  const rs = await Promise.all([validate('entries', v.id), validate('entries', v.id), validate('entries', v.id)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await movementsOf(v.id)).length, 1);
  assert.equal((await level()).quantity, '23.0000');
});

test('bon de prélèvement : motif obligatoire, stock insuffisant refusé sans effet partiel, valorisé au coût moyen', async () => {
  const body = (q, extra = {}) => ({ warehouseId: wh1.id, date: today, reason: 'Casse', lines: [{ productId: prod.id, quantity: q }], ...extra });
  assert.equal((await c('POST', '/stock/withdrawals', { token: A.token, body: body(1, { reason: '' }) })).status, 400);
  const big = await mkVoucher('withdrawals', body(500));
  const r = await validate('withdrawals', big.id);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'STOCK_INSUFFICIENT');
  assert.equal((await c('GET', `/stock/withdrawals/${big.id}`, { token: A.token })).body.data.number, null, 'toujours brouillon, pas de numéro consommé');
  assert.equal((await level()).quantity, '23.0000');
  const ok = await mkVoucher('withdrawals', body(3)); assert.equal((await validate('withdrawals', ok.id)).status, 200);
  const m = (await movementsOf(ok.id))[0];
  assert.equal(m.quantity, '-3.0000'); assert.equal(m.unit_cost, '110.0000'); assert.equal(m.total_cost, '-330.000'); assert.equal(m.balance_after, '20.0000');
  assert.equal((await level()).quantity, '20.0000');
});

test('transfert entre entrepôts : total et coût moyen inchangés, répartition correcte, plafond', async () => {
  const t = await mkVoucher('transfers', { warehouseId: wh1.id, toWarehouseId: wh2.id, date: today, lines: [{ productId: prod.id, quantity: 8 }] });
  assert.equal((await c('POST', '/stock/transfers', { token: A.token, body: { warehouseId: wh1.id, toWarehouseId: wh1.id, date: today, lines: [{ productId: prod.id, quantity: 1 }] } })).status, 400, 'même entrepôt');
  const r = await validate('transfers', t.id); assert.equal(r.status, 200, r.raw);
  const l = await level(); assert.equal(l.quantity, '20.0000'); assert.equal(l.avgCost, '110.0000');
  assert.equal((await level(prod, wh1)).quantity, '12.0000'); assert.equal((await level(prod, wh2)).quantity, '8.0000');
  assert.equal((await movementsOf(t.id)).length, 2);
  const tooMuch = await mkVoucher('transfers', { warehouseId: wh2.id, toWarehouseId: wh1.id, date: today, lines: [{ productId: prod.id, quantity: 9 }] });
  assert.equal((await validate('transfers', tooMuch.id)).status, 409, 'plus que le stock de l\'entrepôt d\'origine');
  assert.equal((await c('POST', `/stock/warehouses/${wh2.id}/archive`, { token: A.token })).status, 409, 'entrepôt non vide');
});

test('annulation d\'un bon : mouvements inverses, refusée si le stock a déjà été consommé', async () => {
  const e = await mkVoucher('entries', entry(prod.id, 5, '110')); await validate('entries', e.id);
  const w = await mkVoucher('withdrawals', { warehouseId: wh1.id, date: today, reason: 'Usage interne', lines: [{ productId: prod.id, quantity: 16 }] }); await validate('withdrawals', w.id);
  assert.equal((await level(prod, wh1)).quantity, '1.0000');
  assert.equal((await c('POST', `/stock/entries/${e.id}/cancel`, { token: A.token, body: { reason: 'erreur de saisie' } })).status, 409, 'annuler l\'entrée rendrait le stock négatif');
  const back = await c('POST', `/stock/withdrawals/${w.id}/cancel`, { token: A.token, body: { reason: 'saisie en double' } });
  assert.equal(back.status, 200, back.raw); assert.equal(back.body.data.status, 'cancelled');
  assert.equal((await level(prod, wh1)).quantity, '17.0000');
  assert.equal((await c('POST', `/stock/withdrawals/${w.id}/cancel`, { token: A.token, body: { reason: 'encore une fois' } })).status, 409, 'une seule annulation');
  assert.equal((await c('POST', `/stock/entries/${e.id}/cancel`, { token: A.token, body: { reason: 'erreur de saisie' } })).status, 200);
  assert.equal((await level()).quantity, '20.0000');
});

test('ajustement direct : motif obligatoire, fixer ou appliquer un écart', async () => {
  const adj = (b) => c('POST', '/stock/adjustments', { token: A.token, body: { productId: prod.id, warehouseId: wh1.id, ...b } });
  assert.equal((await adj({ mode: 'set', quantity: 10, reason: '' })).status, 400);
  assert.equal((await adj({ mode: 'delta', quantity: 1, reason: 'Casse' })).status, 400, 'sens requis');
  assert.equal((await adj({ mode: 'set', quantity: 13, reason: 'Recomptage' })).status, 201);
  assert.equal((await level(prod, wh1)).quantity, '13.0000');
  assert.equal((await adj({ mode: 'set', quantity: 13, reason: 'Recomptage' })).status, 422, 'aucun écart');
  assert.equal((await adj({ mode: 'delta', direction: 'out', quantity: 3, reason: 'Casse constatée' })).status, 201);
  assert.equal((await adj({ mode: 'delta', direction: 'out', quantity: 500, reason: 'Trop' })).status, 409);
  assert.equal((await c('POST', '/stock/adjustments', { token: sales.token, body: { productId: prod.id, warehouseId: wh1.id, mode: 'set', quantity: 1, reason: 'test' } })).status, 403);
  assert.equal((await level(prod, wh1)).quantity, '10.0000');
});

test('inventaire : écarts ajustés à la validation, motif requis, fiche définitive', async () => {
  const r = await c('POST', '/stock/counts', { token: A.token, body: { warehouseId: wh1.id, date: today } });
  assert.equal(r.status, 201, r.raw); const sheet = r.body.data;
  assert.equal(sheet.lines.length, 1); assert.equal(sheet.lines[0].expectedQuantity, '10.0000'); assert.equal(sheet.lines[0].countedQuantity, null);
  assert.equal((await c('POST', `/stock/counts/${sheet.id}/validate`, { token: A.token, body: { reason: 'Inventaire annuel' } })).status, 422, 'rien de compté');
  const put = await c('PUT', `/stock/counts/${sheet.id}/lines`, { token: A.token, body: { lines: [{ productId: prod.id, countedQuantity: 9 }] } });
  assert.equal(put.body.data.lines[0].difference, '-1.0000');
  assert.equal((await c('POST', `/stock/counts/${sheet.id}/validate`, { token: A.token, body: { reason: '' } })).status, 400);
  const ok = await c('POST', `/stock/counts/${sheet.id}/validate`, { token: A.token, body: { reason: 'Inventaire annuel' } });
  assert.equal(ok.status, 200, ok.raw); assert.match(ok.body.data.number, /^INV-\d{4}-\d{5}$/);
  assert.equal((await level(prod, wh1)).quantity, '9.0000');
  assert.equal((await c('POST', `/stock/counts/${sheet.id}/validate`, { token: A.token, body: { reason: 'Inventaire annuel' } })).status, 409);
  assert.equal((await c('DELETE', `/stock/counts/${sheet.id}`, { token: A.token })).status, 409, 'fiche validée définitive');
  assert.equal((await movementsOf(sheet.id)).length, 1);
  const draft = (await c('POST', '/stock/counts', { token: A.token, body: { warehouseId: wh1.id, date: today } })).body.data;
  assert.equal((await c('DELETE', `/stock/counts/${draft.id}`, { token: A.token })).status, 204);
});

test('livraison validée = sortie de stock ; annulée = retour ; jamais deux fois ; stock insuffisant bloque', async () => {
  const order = async (qty) => {
    const o = (await c('POST', '/orders', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ productId: prod.id, quantity: qty, unitPrice: '300', taxRateId: tax19.id }, { productId: plain.id, quantity: 2, unitPrice: '10', taxRateId: tax19.id }] } })).body.data;
    return (await c('POST', `/orders/${o.id}/confirm`, { token: A.token })).body.data;
  };
  const bl = async (o, qty) => (await c('POST', '/delivery-notes', { token: A.token, body: { orderId: o.id, warehouseId: wh1.id, deliveryDate: today, lines: [{ orderLineId: o.lines[0].id, quantity: qty }, { orderLineId: o.lines[1].id, quantity: 2 }] } })).body.data;
  const o1 = await order(4); const n1 = await bl(o1, 4);
  assert.equal(n1.warehouse.id, wh1.id);
  assert.equal((await level(prod, wh1)).quantity, '9.0000', 'brouillon : stock intact');
  const v = await c('POST', `/delivery-notes/${n1.id}/validate`, { token: A.token });
  assert.equal(v.status, 200, v.raw);
  assert.equal((await level(prod, wh1)).quantity, '5.0000'); assert.equal((await level()).quantity, '13.0000');
  const mv = await movementsOf(n1.id); assert.equal(mv.length, 1, 'l\'article non suivi ne bouge pas'); assert.equal(mv[0].kind, 'delivery'); assert.equal(mv[0].quantity, '-4.0000');
  assert.equal((await c('POST', `/delivery-notes/${n1.id}/validate`, { token: A.token })).status, 409);
  assert.equal((await movementsOf(n1.id)).length, 1, 'rafraîchir ou rejouer ne crée pas une 2e sortie');
  const cn = await c('POST', `/delivery-notes/${n1.id}/cancel`, { token: A.token, body: { reason: 'livraison refusée' } });
  assert.equal(cn.status, 200, cn.raw); assert.equal((await level(prod, wh1)).quantity, '9.0000');
  assert.equal((await movementsOf(n1.id)).map((m) => m.kind).sort().join(), 'delivery,delivery_reversal');
  // stock insuffisant : le bon reste brouillon, sans numéro
  const o2 = await order(50); const n2 = await bl(o2, 50);
  const bad = await c('POST', `/delivery-notes/${n2.id}/validate`, { token: A.token });
  assert.equal(bad.status, 409); assert.equal(bad.body.error.code, 'STOCK_INSUFFICIENT');
  const after = (await c('GET', `/delivery-notes/${n2.id}`, { token: A.token })).body.data; assert.equal(after.status, 'draft'); assert.equal(after.number, null);
  // option « autoriser le stock négatif »
  assert.equal((await c('PATCH', '/companies/current/settings', { token: A.token, body: { stock: { allowNegative: true } } })).status, 200);
  assert.equal((await c('POST', `/delivery-notes/${n2.id}/validate`, { token: A.token })).status, 200);
  assert.equal((await level(prod, wh1)).quantity, '-41.0000');
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { stock: { allowNegative: false } } });
});

test('articles : suivi obligatoire pour le stock, désactivation refusée s\'il reste du stock, seuil d\'alerte', async () => {
  const r = await c('POST', '/stock/entries', { token: A.token, body: entry(plain.id, 1, '5') });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'NOT_TRACKED');
  const off = await c('PATCH', `/products/${prod.id}`, { token: A.token, body: { trackStock: false } });
  assert.equal(off.status, 409); assert.equal(off.body.error.code, 'HAS_STOCK');
  const small = (await c('POST', '/products', { token: A.token, body: { name: 'Pièce rare', salePrice: '5', taxRateId: tax19.id, trackStock: true, stockAlertThreshold: '5' } })).body.data;
  const e = await mkVoucher('entries', entry(small.id, 3, '2')); await validate('entries', e.id);
  const below = (await c('GET', '/stock/levels?below=1', { token: A.token })).body.data;
  assert.ok(below.some((x) => x.productId === small.id && x.belowThreshold)); assert.ok(below.some((x) => x.productId === prod.id), 'le stock négatif est sous le seuil');
});

test('mouvements et valorisation : journal complet, lecture seule, isolation', async () => {
  const mv = await c('GET', `/stock/movements?productId=${prod.id}&limit=100`, { token: A.token });
  assert.equal(mv.status, 200); assert.ok(mv.body.data.length >= 8);
  const kinds = new Set(mv.body.data.map((m) => m.kind)); for (const k of ['entry', 'withdrawal', 'transfer_in', 'transfer_out', 'adjustment', 'inventory', 'delivery', 'delivery_reversal', 'cancellation']) assert.ok(kinds.has(k), k);
  assert.equal((await c('GET', '/stock/movements', { token: B.token })).body.data.length, 0, 'isolation');
  assert.equal((await c('DELETE', `/stock/movements/${mv.body.data[0].id}`, { token: A.token })).status, 404, 'aucune route de suppression');
  const lv = await c('GET', '/stock/levels', { token: A.token });
  assert.equal(lv.body.meta.valuation, 'Coût moyen pondéré'); assert.match(lv.body.meta.totalValue, /^-?\d+\.\d{3}$/);
  // cohérence : somme des mouvements = niveau
  const [[s]] = await pool.query('SELECT SUM(quantity) AS q FROM stock_movements WHERE product_id = (SELECT id FROM products WHERE public_id = ?)', [prod.id]);
  const [[ps]] = await pool.query('SELECT quantity FROM product_stock WHERE product_id = (SELECT id FROM products WHERE public_id = ?)', [prod.id]);
  assert.equal(Number(s.q), Number(ps.quantity));
  const [[lvsum]] = await pool.query('SELECT SUM(quantity) AS q FROM stock_levels WHERE product_id = (SELECT id FROM products WHERE public_id = ?)', [prod.id]);
  assert.equal(Number(lvsum.q), Number(ps.quantity));
});

test('impression des bons de stock : PDF pour entrée, prélèvement et transfert ; droits et isolation', async () => {
  const pdfOf = (kind, id, token) => fetch(`${app.base}/stock/${kind}/${id}/pdf`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const pp = (await c('POST', '/products', { token: A.token, body: { name: 'Article impression', salePrice: '10', taxRateId: tax19.id, trackStock: true } })).body.data;
  const dest = (await c('POST', '/stock/warehouses', { token: A.token, body: { name: 'Dépôt impression', code: 'IMP' } })).body.data;
  const e = await mkVoucher('entries', entry(pp.id, 5, '12.5', { notes: 'Livraison fournisseur — contrôle visuel OK' }));
  const draft = await pdfOf('entries', e.id, A.token); const dBuf = Buffer.from(await draft.arrayBuffer());
  assert.equal(draft.status, 200); assert.equal(draft.headers.get('content-type'), 'application/pdf'); assert.equal(dBuf.subarray(0, 5).toString(), '%PDF-');
  assert.match(draft.headers.get('content-disposition'), /BEN-brouillon\.pdf/);
  const vr = await validate('entries', e.id); assert.equal(vr.status, 200, vr.raw);
  const val = await pdfOf('entries', e.id, readOnly.token); assert.equal(val.status, 200, 'la lecture seule peut imprimer');
  assert.match(val.headers.get('content-disposition'), /BEN-\d{4}-\d{5}\.pdf/);
  const w = await mkVoucher('withdrawals', { warehouseId: wh1.id, date: today, reason: 'Casse constatée', lines: [{ productId: pp.id, quantity: 1 }] });
  assert.equal((await pdfOf('withdrawals', w.id, A.token)).status, 200);
  const t = await mkVoucher('transfers', { warehouseId: wh1.id, toWarehouseId: dest.id, date: today, lines: [{ productId: pp.id, quantity: 1 }] });
  assert.equal((await pdfOf('transfers', t.id, A.token)).status, 200);
  assert.equal((await pdfOf('entries', e.id, B.token)).status, 404, 'isolation entre sociétés');
  assert.equal((await pdfOf('withdrawals', e.id, A.token)).status, 404, 'un bon d\'entrée ne s\'imprime pas via la route des prélèvements');
  assert.equal((await pdfOf('entries', e.id, null)).status, 401);
});

test('bons de stock : les modèles d\'en-tête et de pied de page choisis dans les réglages s\'appliquent', async () => {
  const pp = (await c('POST', '/products', { token: A.token, body: { name: 'Article cadre', salePrice: '10', taxRateId: tax19.id, trackStock: true } })).body.data;
  const e = await mkVoucher('entries', entry(pp.id, 2, '3'));
  for (const headerStyle of ['classic', 'centered', 'band', 'minimal', 'custom']) for (const footerStyle of ['classic', 'columns', 'minimal', 'custom']) {
    const s = await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { headerStyle, footerStyle, headerText: 'Entrepôt Central\nZone Nabeul', footerText: 'Pied bon de stock' } } });
    assert.equal(s.status, 200, s.raw);
    const r = await fetch(`${app.base}/stock/entries/${e.id}/pdf`, { headers: { authorization: `Bearer ${A.token}` } });
    assert.equal(r.status, 200, `${headerStyle}/${footerStyle}`); assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  }
  await c('PATCH', '/companies/current/settings', { token: A.token, body: { branding: { headerStyle: 'classic', footerStyle: 'classic' } } });
});
