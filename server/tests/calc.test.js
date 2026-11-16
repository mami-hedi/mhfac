import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDocument, toScaled, fromScaled, addMoney, subMoney, cmpMoney } from '../src/core/calc.js';

const L = (quantity, unitPrice, taxRate, discountPct = 0) => ({ quantity, unitPrice, taxRate, discountPct });

test('TVA simple 19 % : 100 HT -> 19 TVA -> 119 TTC', () => {
  const r = computeDocument({ lines: [L(1, '100.000', 19)] });
  assert.equal(r.totalHt, '100.000'); assert.equal(r.totalTax, '19.000'); assert.equal(r.totalTtc, '119.000'); assert.equal(r.netPayable, '119.000');
  assert.deepEqual(r.taxes, [{ taxRate: '19.00', base: '100.000', amount: '19.000' }]);
});

test('pas d\'erreur de flottant : 0,1 + 0,2 et 1,005 × 3', () => {
  const r = computeDocument({ lines: [L(1, '0.100', 0), L(1, '0.200', 0)] });
  assert.equal(r.totalHt, '0.300');
  assert.equal(computeDocument({ lines: [L(3, '1.005', 0)] }).totalHt, '3.015');
});

test('quantités décimales (4 décimales) : 2,5 × 12,500', () => {
  assert.equal(computeDocument({ lines: [L('2,5', '12.500', 0)] }).totalHt, '31.250');
  assert.equal(computeDocument({ lines: [L('0.3333', '3.000', 0)] }).totalHt, '1.000'); // 0,9999 -> 1,000
});

test('remise de ligne : 100 × 10 % = 90', () => {
  const r = computeDocument({ lines: [L(1, '100', 19, 10)] });
  assert.equal(r.lines[0].netAmount, '90.000'); assert.equal(r.lines[0].discountAmount, '10.000');
  assert.equal(r.totalTax, '17.100'); assert.equal(r.totalTtc, '107.100'); assert.equal(r.lineDiscountTotal, '10.000');
});

test('remise globale appliquée à chaque base de TVA', () => {
  const r = computeDocument({ lines: [L(1, '100', 19), L(1, '100', 7)], globalDiscountPct: 10 });
  assert.deepEqual(r.taxes, [{ taxRate: '7.00', base: '90.000', amount: '6.300' }, { taxRate: '19.00', base: '90.000', amount: '17.100' }]);
  assert.equal(r.totalHt, '180.000'); assert.equal(r.globalDiscountAmount, '20.000'); assert.equal(r.totalTtc, '203.400');
});

test('TVA arrondie par base, pas par ligne (3 lignes à 0,333 à 19 %)', () => {
  const r = computeDocument({ lines: [L(1, '0.333', 19), L(1, '0.333', 19), L(1, '0.333', 19)] });
  assert.equal(r.totalHt, '0.999');
  assert.equal(r.totalTax, '0.190'); // 0,999 × 19 % = 0,18981 -> 0,190 (par ligne : 3 × 0,063 = 0,189)
});

test('arrondi demi supérieur au millime', () => {
  assert.equal(computeDocument({ lines: [L(1, '0.005', 19)] }).totalTax, '0.001'); // 0,00095 -> 0,001
  assert.equal(computeDocument({ lines: [L(1, '0.002', 19)] }).totalTax, '0.000'); // 0,00038 -> 0
  assert.equal(computeDocument({ lines: [L(1, '0.500', 19)] }).totalTax, '0.095');
  assert.equal(computeDocument({ lines: [L(1, '0.0', 19)] }).totalTtc, '0.000');
});

test('timbre fiscal hors base de TVA ; retenue sur le TTC', () => {
  const r = computeDocument({ lines: [L(1, '1000', 19)], stampDuty: '1.000', withholdingPct: '1.5' });
  assert.equal(r.totalTtc, '1190.000'); assert.equal(r.stampDuty, '1.000');
  assert.equal(r.withholdingAmount, '17.850'); assert.equal(r.netPayable, '1173.150');
  assert.equal(r.totalTax, '190.000');
});

test('taux 0 (exonéré) et mélange de taux', () => {
  const r = computeDocument({ lines: [L(2, '50', 0), L(1, '200', 13), L(1, '100', 19)] });
  assert.equal(r.taxes.length, 3); assert.equal(r.totalHt, '400.000'); assert.equal(r.totalTax, '45.000'); assert.equal(r.totalTtc, '445.000');
});

test('grands montants sans perte (12 chiffres)', () => {
  const r = computeDocument({ lines: [L('1000000', '999999999.999', 19)] });
  assert.equal(r.totalHt, '999999999999000.000');
  assert.equal(r.totalTax, '189999999999810.000');
});

test('entrées invalides refusées', () => {
  assert.throws(() => computeDocument({ lines: [L(1, '1.0005', 19)] }));
  assert.throws(() => computeDocument({ lines: [L(1, '10', 19, 101)] }));
  assert.throws(() => computeDocument({ lines: [L(-1, '10', 19)] }));
  assert.throws(() => computeDocument({ lines: [L(1, '10', 19)], globalDiscountPct: 120 }));
  assert.throws(() => computeDocument({ lines: [L('abc', '10', 19)] }));
});

test('utilitaires décimaux', () => {
  assert.equal(toScaled('12,5', 3), 12500n); assert.equal(fromScaled(5n, 3), '0.005');
  assert.equal(addMoney('0.100', '0.200'), '0.300'); assert.equal(subMoney('1.000', '0.001'), '0.999');
  assert.equal(cmpMoney('1.000', '1.0'), 0); assert.equal(cmpMoney('0.999', '1'), -1);
});

test('addMoney / subMoney / cmpMoney : résultats négatifs acceptés (solde après avoir supérieur au net à payer)', async () => {
  const { subMoney, addMoney, cmpMoney, toScaled } = await import('../src/core/calc.js');
  assert.equal(subMoney('100.000', '2491.186'), '-2391.186');
  assert.equal(cmpMoney('-2391.186', '0'), -1); assert.equal(cmpMoney('0', '-1.000'), 1); assert.equal(cmpMoney('-1.000', '-1.000'), 0);
  assert.equal(addMoney('-2391.186', '2391.186'), '0.000');
  assert.throws(() => toScaled('-5', 3), /Montant invalide/, 'la validation des saisies reste stricte');
});
