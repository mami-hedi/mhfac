import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS, ROLES, permissionsForRole } from '../src/core/permissions.js';

test('le proprietaire a toutes les permissions metier hors abonnement manquant', () => {
  const owner = new Set(permissionsForRole('owner'));
  assert.ok(owner.has('invoice.validate') && owner.has('user.write') && owner.has('subscription.write'));
});
test('lecture seule : uniquement des permissions .read', () => {
  const p = permissionsForRole('read_only');
  assert.ok(p.length > 0);
  assert.ok(p.every((c) => c.endsWith('.read')));
  assert.ok(!p.includes('user.read') && !p.includes('settings.read'));
});
test('gestionnaire de stock : pas de factures ni de paiements', () => {
  const p = new Set(permissionsForRole('stock_manager'));
  assert.ok(!p.has('invoice.read') && !p.has('payment.read'));
  assert.ok(p.has('stock.validate') && p.has('purchase_receipt.validate'));
});
test('commercial : pas de gestion des utilisateurs, ne valide pas une facture', () => {
  const p = new Set(permissionsForRole('sales'));
  assert.ok(!p.has('user.read') && !p.has('invoice.validate') && p.has('invoice.write'));
});
test('chaque permission attribuee existe dans le catalogue', () => {
  const all = new Set(PERMISSIONS);
  for (const r of ROLES) for (const c of permissionsForRole(r.code)) assert.ok(all.has(c), c);
});
test('aucune suppression de facture emise : pas de permission invoice.delete pour le comptable', () => {
  assert.ok(!permissionsForRole('accountant').includes('invoice.delete'));
});
