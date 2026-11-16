import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCompany, addMember } from './helpers.js';

let app, A, B, accountant, readOnly, client, sup, tax19, bank, cash, usd;
const c = (...a) => app.call(...a);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const ok = (r, s = 200) => { assert.equal(r.status, s, r.raw); return r.body.data; };
let n = 0;
async function issued(price = '100.000') {
  const d = ok(await c('POST', '/invoices', { token: A.token, body: { clientId: client.id, issueDate: today, lines: [{ description: 'Prestation', quantity: 1, unitPrice: price, taxRateId: tax19.id }] } }), 201);
  return ok(await c('POST', `/invoices/${d.id}/issue`, { token: A.token })); // 100 HT -> 119 TTC
}
async function purchaseInv(price = '100') {
  const d = ok(await c('POST', '/purchase-invoices', { token: A.token, body: { supplierId: sup.id, issueDate: today, supplierRef: `F-${Date.now()}-${++n}`, lines: [{ description: 'Achat', quantity: 1, unitPrice: price, taxRateId: tax19.id }] } }), 201);
  return ok(await c('POST', `/purchase-invoices/${d.id}/record`, { token: A.token }));
}
const pay = (body, token = A.token) => c('POST', '/payments', { token, body: { date: today, method: 'bank_transfer', ...body } });
const bal = async (acc) => ok(await c('GET', `/treasury/accounts/${acc.id}`, { token: A.token })).balance;
const txsRes = async (acc, extra = "") => (await c("GET", `/treasury/transactions?accountId=${acc.id}${extra}`, { token: A.token }));
const txs = async (acc, extra = "") => ({ data: ok(await txsRes(acc, extra)) });

before(async () => {
  app = await startApp();
  A = await registerCompany(app.call, 'Tréso A'); B = await registerCompany(app.call, 'Tréso B');
  accountant = await addMember(app.call, A, 'accountant'); readOnly = await addMember(app.call, A, 'read_only');
  client = ok(await c('POST', '/clients', { token: A.token, body: { name: 'Client Tréso' } }), 201);
  sup = ok(await c('POST', '/suppliers', { token: A.token, body: { name: 'Fournisseur Tréso' } }), 201);
  tax19 = ok(await c('GET', '/tax-rates', { token: A.token })).find((t) => t.rate === '19.00');
});
after(() => app.close());

test('comptes : création, code unique, solde d\'ouverture, droits, isolation, archivage', async () => {
  bank = ok(await c('POST', '/treasury/accounts', { token: A.token, body: { code: 'biat', name: 'BIAT courant', type: 'bank', bankName: 'BIAT', openingBalance: '1000' } }), 201);
  assert.equal(bank.code, 'BIAT'); assert.equal(bank.balance, '1000.000');
  cash = ok(await c('POST', '/treasury/accounts', { token: A.token, body: { code: 'CAISSE', name: 'Caisse principale', type: 'cash' } }), 201);
  usd = ok(await c('POST', '/treasury/accounts', { token: A.token, body: { code: 'USD1', name: 'Compte USD', currency: 'USD' } }), 201);
  assert.equal((await c('POST', '/treasury/accounts', { token: A.token, body: { code: 'BIAT', name: 'Doublon' } })).status, 409);
  assert.equal((await c('POST', '/treasury/accounts', { token: readOnly.token, body: { code: 'XX', name: 'Interdit' } })).status, 403);
  assert.equal(ok(await c('GET', '/treasury/accounts', { token: B.token })).length, 0, 'isolation');
  assert.equal((await c('GET', `/treasury/accounts/${bank.id}`, { token: B.token })).status, 422);
  const tmp = ok(await c('POST', '/treasury/accounts', { token: A.token, body: { code: 'TMP', name: 'Temporaire' } }), 201);
  assert.equal(ok(await c('POST', `/treasury/accounts/${tmp.id}/archive`, { token: A.token })).status, 'archived');
  assert.equal((await c('POST', '/treasury/transactions', { token: A.token, body: { accountId: tmp.id, date: today, direction: 'in', amount: '10', label: 'test' } })).status, 422, 'compte archivé');
  assert.equal(ok(await c('GET', '/treasury/accounts?status=active', { token: A.token })).length, 3);
});

test('règlement client avec compte : écriture immédiate, annulation, rapprochement bloquant', async () => {
  const inv = await issued(); const before0 = await bal(bank);
  const p = ok(await pay({ clientId: client.id, accountId: bank.id, allocations: [{ invoiceId: inv.id, amount: '119' }], reference: 'VIR-1' }), 201);
  assert.equal(p.account.id, bank.id);
  assert.equal(await bal(bank), '1119.000'); assert.equal(before0, '1000.000');
  const t = (await txs(bank, '&kind=client_payment')).data[0]; assert.equal(t.direction, 'in'); assert.equal(t.amount, '119.000'); assert.match(t.number, /^TRS-\d{4}-\d{5}$/);
  // rapprochement
  assert.equal(ok(await c('POST', '/treasury/transactions/reconcile', { token: A.token, body: { ids: [t.id], reconciled: true } })).updated, 1);
  assert.equal(ok(await c('GET', `/treasury/accounts/${bank.id}`, { token: A.token })).reconciledBalance, '1119.000');
  const blocked = await c('POST', `/payments/${p.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'RECONCILED');
  assert.equal((await c('POST', `/treasury/transactions/${t.id}/cancel`, { token: A.token, body: { reason: 'Tentative directe' } })).status, 409, 'écriture liée à un règlement');
  ok(await c('POST', '/treasury/transactions/reconcile', { token: A.token, body: { ids: [t.id], reconciled: false } }));
  ok(await c('POST', `/payments/${p.id}/cancel`, { token: A.token, body: { reason: 'Erreur de saisie' } }));
  assert.equal(await bal(bank), '1000.000', 'solde rétabli');
  assert.equal(ok(await c('GET', `/invoices/${inv.id}`, { token: A.token })).balance, '119.000');
  assert.equal((await txs(bank, '&status=cancelled')).data.length, 1, 'écriture conservée, annulée');
  assert.equal((await pay({ clientId: client.id, accountId: usd.id, allocations: [{ invoiceId: inv.id, amount: '10' }] })).body.error.code, 'CURRENCY_MISMATCH');
});

test('chèque reçu : instrument en attente, remise, encaissement crédite le compte ; impayé annule le règlement', async () => {
  const i1 = await issued(); const i2 = await issued(); const b0 = await bal(bank);
  const p1 = ok(await pay({ clientId: client.id, method: 'cheque', reference: 'CHQ-123', bankName: 'STB', dueDate: today, accountId: bank.id, allocations: [{ invoiceId: i1.id, amount: '119' }] }), 201);
  assert.equal(p1.instrument.status, 'pending'); assert.equal(await bal(bank), b0, 'un chèque en attente ne crédite pas le compte');
  assert.equal(ok(await c('GET', `/invoices/${i1.id}`, { token: A.token })).paymentStatus, 'paid', 'la facture est réglée à la réception du chèque');
  const ins = ok(await c('GET', '/treasury/instruments?status=pending', { token: A.token })).find((x) => x.payment.number === p1.number);
  assert.equal(ins.direction, 'received'); assert.equal(ins.type, 'cheque'); assert.equal(ins.number, 'CHQ-123'); assert.equal(ins.bankName, 'STB');
  assert.equal(ok(await c('POST', `/treasury/instruments/${ins.id}/deposit`, { token: A.token, body: { date: today } })).status, 'deposited');
  assert.equal((await c('POST', `/treasury/instruments/${ins.id}/deposit`, { token: A.token, body: { date: today } })).status, 409);
  const cleared = ok(await c('POST', `/treasury/instruments/${ins.id}/clear`, { token: A.token, body: { date: today } })); assert.equal(cleared.status, 'cleared');
  assert.equal(await bal(bank), '1119.000');
  assert.equal((await c('POST', `/treasury/instruments/${ins.id}/clear`, { token: A.token, body: { date: today } })).status, 409, 'jamais deux écritures');
  assert.equal((await txs(bank, '&kind=instrument')).data.length, 1);
  // impayé sur un second chèque
  const p2 = ok(await pay({ clientId: client.id, method: 'bill_of_exchange', reference: 'EFF-9', allocations: [{ invoiceId: i2.id, amount: '119' }] }), 201);
  const ins2 = ok(await c('GET', '/treasury/instruments?type=bill', { token: A.token }))[0];
  assert.equal((await c('POST', `/treasury/instruments/${ins2.id}/clear`, { token: A.token, body: { date: today } })).body.error.code, 'ACCOUNT_REQUIRED');
  assert.equal((await c('POST', `/treasury/instruments/${ins2.id}/bounce`, { token: readOnly.token, body: { date: today, reason: 'Provision insuffisante' } })).status, 403);
  const b = ok(await c('POST', `/treasury/instruments/${ins2.id}/bounce`, { token: A.token, body: { date: today, reason: 'Provision insuffisante' } }));
  assert.equal(b.status, 'bounced');
  assert.equal(ok(await c('GET', `/payments/${p2.id}`, { token: A.token })).status, 'cancelled');
  const inv2 = ok(await c('GET', `/invoices/${i2.id}`, { token: A.token })); assert.equal(inv2.balance, '119.000'); assert.equal(inv2.paymentStatus, 'unpaid');
  assert.equal((await c('POST', `/treasury/instruments/${ins2.id}/clear`, { token: A.token, body: { date: today, accountId: bank.id } })).status, 409, 'impayé = final');
});

test('règlement fournisseur : sortie de compte ; chèque émis débité à l\'encaissement', async () => {
  const pi = await purchaseInv('100'); const b0 = await bal(bank);
  const p = ok(await c('POST', '/supplier-payments', { token: A.token, body: { supplierId: sup.id, date: today, method: 'bank_transfer', accountId: bank.id, allocations: [{ invoiceId: pi.id, amount: '50' }] } }), 201);
  assert.equal(await bal(bank), subtract(b0, '50.000'));
  ok(await c('POST', `/supplier-payments/${p.id}/cancel`, { token: A.token, body: { reason: 'Virement annulé' } }));
  assert.equal(await bal(bank), b0);
  const pc = ok(await c('POST', '/supplier-payments', { token: A.token, body: { supplierId: sup.id, date: today, method: 'cheque', reference: 'MON-CHQ-1', allocations: [{ invoiceId: pi.id, amount: '119' }] } }), 201);
  const ins = ok(await c('GET', '/treasury/instruments?direction=issued', { token: A.token }))[0]; assert.equal(ins.direction, 'issued');
  assert.equal((await c('POST', `/treasury/instruments/${ins.id}/deposit`, { token: A.token, body: { date: today } })).status, 409, 'un chèque émis ne se remet pas en banque');
  ok(await c('POST', `/treasury/instruments/${ins.id}/clear`, { token: A.token, body: { date: today, accountId: bank.id } }));
  assert.equal(await bal(bank), subtract(b0, '119.000'));
  const blocked = (await txs(bank, '&kind=instrument')).data.find((t) => t.direction === 'out');
  ok(await c('POST', '/treasury/transactions/reconcile', { token: A.token, body: { ids: [blocked.id], reconciled: true } }));
  assert.equal((await c('POST', `/supplier-payments/${pc.id}/cancel`, { token: A.token, body: { reason: 'Annulation après encaissement' } })).status, 409, 'écriture rapprochée');
  ok(await c('POST', '/treasury/transactions/reconcile', { token: A.token, body: { ids: [blocked.id], reconciled: false } }));
  ok(await c('POST', `/supplier-payments/${pc.id}/cancel`, { token: A.token, body: { reason: 'Annulation après encaissement' } }));
  assert.equal(await bal(bank), b0); assert.equal(ok(await c('GET', `/purchase-invoices/${pi.id}`, { token: A.token })).balance, '119.000');
});
const subtract = (a, b) => (Math.round((Number(a) - Number(b)) * 1000) / 1000).toFixed(3);

test('écritures manuelles, virement interne, annulation, avant ouverture', async () => {
  const b0 = await bal(bank); const c0 = await bal(cash);
  const m = ok(await c('POST', '/treasury/transactions', { token: A.token, body: { accountId: bank.id, date: today, direction: 'out', amount: '12,500', label: 'Frais bancaires' } }), 201);
  assert.equal(await bal(bank), subtract(b0, '12.500'));
  assert.equal((await c('POST', '/treasury/transactions', { token: A.token, body: { accountId: bank.id, date: '2999-01-01', direction: 'in', amount: '10', label: 'Futur' } })).status, 422);
  assert.equal((await c('POST', '/treasury/transactions', { token: A.token, body: { accountId: bank.id, date: '2000-01-01', direction: 'in', amount: '10', label: 'Avant ouverture' } })).body.error.code, 'BEFORE_OPENING');
  assert.equal((await c('POST', '/treasury/transactions', { token: A.token, body: { accountId: bank.id, date: today, direction: 'in', amount: '0', label: 'Zéro' } })).status, 400);
  const tr = ok(await c('POST', '/treasury/transfers', { token: A.token, body: { fromAccountId: bank.id, toAccountId: cash.id, date: today, amount: '200' } }), 201);
  assert.equal(tr.length, 2); assert.equal(await bal(bank), subtract(b0, '212.500')); assert.equal(await bal(cash), subtract(c0, '-200'));
  assert.equal((await c('POST', '/treasury/transfers', { token: A.token, body: { fromAccountId: bank.id, toAccountId: usd.id, date: today, amount: '5' } })).body.error.code, 'CURRENCY_MISMATCH');
  assert.equal((await c('POST', '/treasury/transfers', { token: A.token, body: { fromAccountId: bank.id, toAccountId: bank.id, date: today, amount: '5' } })).body.error.code, 'SAME_ACCOUNT');
  ok(await c('POST', `/treasury/transactions/${tr[0].id}/cancel`, { token: A.token, body: { reason: 'Virement erroné' } }));
  assert.equal(await bal(cash), c0, 'les deux écritures du virement sont annulées'); assert.equal(await bal(bank), subtract(b0, '12.500'));
  ok(await c('POST', `/treasury/transactions/${m.id}/cancel`, { token: accountant.token, body: { reason: 'Saisie en double' } }));
  assert.equal(await bal(bank), b0);
  assert.equal((await c('POST', `/treasury/transactions/${m.id}/cancel`, { token: A.token, body: { reason: 'Encore annulée' } })).status, 409);
  assert.equal((await c('POST', '/treasury/transactions', { token: readOnly.token, body: { accountId: bank.id, date: today, direction: 'in', amount: '1', label: 'Interdit' } })).status, 403);
  assert.equal((await c('PUT', `/treasury/accounts/${bank.id}`, { token: A.token, body: { name: 'BIAT', openingBalance: '5' } })).status, 409, 'solde d\'ouverture figé après écritures');
  const list = await txsRes(bank); assert.ok(list.body.meta.totalIn !== undefined);
  const sum = ok(await c('GET', '/treasury/summary', { token: A.token })); assert.ok(sum.byCurrency.TND);
});

test('trop-perçu : avance conservée, affectation ultérieure, plafonds, avance pure', async () => {
  const i1 = await issued(); const i2 = await issued(); const b0 = await bal(bank);
  const p = ok(await pay({ clientId: client.id, accountId: bank.id, amount: '500', allocations: [{ invoiceId: i1.id, amount: '119' }] }), 201);
  assert.equal(p.amount, '500.000'); assert.equal(p.allocated, '119.000'); assert.equal(p.unallocated, '381.000');
  assert.equal(await bal(bank), subtract(b0, '-500'), 'la trésorerie enregistre le montant réellement reçu');
  assert.equal((await pay({ clientId: client.id, amount: '50', allocations: [{ invoiceId: i2.id, amount: '119' }] })).body.error.code, 'AMOUNT_BELOW_ALLOCATIONS');
  const adv = ok(await c('GET', '/payments?unallocated=1', { token: A.token })); assert.ok(adv.some((x) => x.id === p.id));
  assert.equal((await c('POST', `/payments/${p.id}/allocate`, { token: A.token, body: { allocations: [{ invoiceId: i2.id, amount: '400' }] } })).status, 422, 'plus que le solde de la facture / de l\'avance');
  const a2 = ok(await c('POST', `/payments/${p.id}/allocate`, { token: A.token, body: { allocations: [{ invoiceId: i2.id, amount: '119' }] } }));
  assert.equal(a2.unallocated, '262.000');
  assert.equal(ok(await c('GET', `/invoices/${i2.id}`, { token: A.token })).paymentStatus, 'paid');
  assert.equal((await c('POST', `/payments/${p.id}/allocate`, { token: A.token, body: { allocations: [{ invoiceId: i2.id, amount: '1' }] } })).status, 422, 'facture déjà soldée');
  // avance pure sans facture
  const pure = ok(await pay({ clientId: client.id, amount: '80', method: 'cash', accountId: cash.id, allocations: [] }), 201);
  assert.equal(pure.unallocated, '80.000'); assert.equal(pure.currency, 'TND');
  const i3 = await issued();
  const used = ok(await c('POST', `/payments/${pure.id}/allocate`, { token: A.token, body: { allocations: [{ invoiceId: i3.id, amount: '80' }] } }));
  assert.equal(used.unallocated, '0.000'); assert.equal(ok(await c('GET', `/invoices/${i3.id}`, { token: A.token })).balance, '39.000');
  assert.equal((await pay({ clientId: client.id, allocations: [] })).status, 400, 'ni montant ni facture');
  // annuler le règlement rétablit les soldes des deux factures et la trésorerie
  ok(await c('POST', `/payments/${p.id}/cancel`, { token: A.token, body: { reason: 'Règlement saisi à tort' } }));
  assert.equal(ok(await c('GET', `/invoices/${i1.id}`, { token: A.token })).balance, '119.000'); assert.equal(ok(await c('GET', `/invoices/${i2.id}`, { token: A.token })).balance, '119.000');
  assert.equal(await bal(bank), b0);
  // règlement fournisseur avec avance
  const pi = await purchaseInv('100');
  const sp = ok(await c('POST', '/supplier-payments', { token: A.token, body: { supplierId: sup.id, date: today, method: 'bank_transfer', amount: '300', allocations: [{ invoiceId: pi.id, amount: '119' }] } }), 201);
  assert.equal(sp.unallocated, '181.000');
});
