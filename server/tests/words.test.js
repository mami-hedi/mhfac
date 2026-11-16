import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, frenchInteger } from '../src/core/words.js';

test('français : nombres de référence (accords de cent, vingt, mille, et, traits d\'union)', () => {
  const cases = { 0: 'zéro', 1: 'un', 16: 'seize', 21: 'vingt et un', 22: 'vingt-deux', 70: 'soixante-dix', 71: 'soixante et onze', 77: 'soixante-dix-sept', 80: 'quatre-vingts', 81: 'quatre-vingt-un', 91: 'quatre-vingt-onze', 99: 'quatre-vingt-dix-neuf',
    100: 'cent', 101: 'cent un', 200: 'deux cents', 201: 'deux cent un', 280: 'deux cent quatre-vingts', 1000: 'mille', 1001: 'mille un', 2000: 'deux mille', 80000: 'quatre-vingt mille', 200000: 'deux cent mille', 3052: 'trois mille cinquante-deux',
    1000000: 'un million', 2000000: 'deux millions', 1500000: 'un million cinq cent mille', 2000000000: 'deux milliards', 123456789: 'cent vingt-trois millions quatre cent cinquante-six mille sept cent quatre-vingt-neuf' };
  for (const [n, w] of Object.entries(cases)) assert.equal(frenchInteger(Number(n)), w, n);
});

test('montant en lettres : dinars et millimes, singulier/pluriel, zéro, négatif, devises', () => {
  assert.equal(amountInWords('3052.750'), 'trois mille cinquante-deux dinars et sept cent cinquante millimes');
  assert.equal(amountInWords('1.000'), 'un dinar');
  assert.equal(amountInWords('0.001'), 'un millime');
  assert.equal(amountInWords('0.500'), 'cinq cents millimes');
  assert.equal(amountInWords('21.021'), 'vingt et un dinars et vingt et un millimes');
  assert.equal(amountInWords('0.000'), 'zéro dinar');
  assert.equal(amountInWords('-119.000'), 'moins cent dix-neuf dinars');
  assert.equal(amountInWords('2000000.000'), 'deux millions dinars');
  assert.equal(amountInWords('10.00', 'EUR'), 'dix euros');
  assert.equal(amountInWords('10.050', 'EUR'), 'dix euros et cinq centimes');
  assert.equal(amountInWords('10.055', 'EUR'), null, 'jamais de troncature silencieuse d\'un montant');
  assert.equal(amountInWords('abc'), null);
  assert.equal(amountInWords('1.5', 'TND'), 'un dinar et cinq cents millimes');
});

