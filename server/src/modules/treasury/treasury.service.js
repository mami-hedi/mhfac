// Service trésorerie : écritures, rattachement des règlements, chèques/effets. Tout est fait dans la transaction de l'appelant.
// Les montants restent en DECIMAL (chaînes) et les sommes passent par core/calc.js : jamais de flottant.
import { newPublicId } from '../../core/ids.js';
import { nextDocNumber } from '../../core/numbering.js';
import { subMoney } from '../../core/calc.js';

// Addition signée (BigInt, millimes) : les soldes peuvent être négatifs.
const sc = (v) => { const raw = String(v ?? '0').trim(); const neg = raw.startsWith('-'); const [i, f = ''] = raw.replace('-', '').split('.'); const n = BigInt(i + f.padEnd(3, '0').slice(0, 3)); return neg ? -n : n; };
export const addSigned = (a, b) => { const n = sc(a) + sc(b); const neg = n < 0n; const t = (neg ? -n : n).toString().padStart(4, '0'); return `${neg ? '-' : ''}${t.slice(0, -3)}.${t.slice(-3)}`; };
import { HttpError } from '../../utils/httpError.js';

export const INSTRUMENT_METHODS = { cheque: 'cheque', bill_of_exchange: 'bill' };

export async function findAccount(conn, companyId, publicId, { activeOnly = true, forUpdate = false } = {}) {
  const [[a]] = await conn.query(`SELECT *, DATE_FORMAT(opening_date,'%Y-%m-%d') AS opening_date_s FROM treasury_accounts WHERE company_id = ? AND public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId]);
  if (!a) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Compte de trésorerie introuvable');
  if (activeOnly && a.status !== 'active') throw new HttpError(422, 'ACCOUNT_ARCHIVED', `Le compte « ${a.name} » est archivé`);
  return a;
}
const findAccountById = async (conn, companyId, id) => {
  const [[a]] = await conn.query("SELECT *, DATE_FORMAT(opening_date,'%Y-%m-%d') AS opening_date_s FROM treasury_accounts WHERE company_id = ? AND id = ?", [companyId, id]);
  return a;
};

// Écriture de trésorerie (entrée ou sortie). La date ne peut précéder l'ouverture du compte.
export async function addTransaction(conn, { companyId, userId }, { account, date, direction, amount, kind, label, reference, sourceType = null, sourceId = null, transferGroup = null }) {
  if (date < account.opening_date_s) throw new HttpError(422, 'BEFORE_OPENING', `La date précède l'ouverture du compte « ${account.name} » (${account.opening_date_s})`);
  const series = date.slice(0, 4);
  const number = await nextDocNumber(conn, companyId, 'treasury_tx', series);
  const publicId = newPublicId();
  try {
    await conn.query('INSERT INTO treasury_transactions (public_id, company_id, number, account_id, tx_date, direction, amount, kind, label, reference, source_type, source_id, transfer_group, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [publicId, companyId, number, account.id, date, direction, amount, kind, label, reference ?? null, sourceType, sourceId, transferGroup, userId]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'ALREADY_RECORDED', 'Cette opération a déjà généré son écriture de trésorerie');
    throw e;
  }
  return { publicId, number };
}

// Solde d'un compte = ouverture + entrées − sorties (écritures non annulées). Le solde rapproché ne compte que les écritures pointées.
export async function balances(conn, companyId, accountIds = null) {
  if (Array.isArray(accountIds) && accountIds.length === 0) return new Map();
  const [rows] = await conn.query(
    `SELECT a.id, a.opening_balance,
       COALESCE(SUM(CASE WHEN t.status = 'recorded' THEN IF(t.direction = 'in', t.amount, -t.amount) END), 0) AS movement,
       COALESCE(SUM(CASE WHEN t.status = 'recorded' AND t.reconciled = 1 THEN IF(t.direction = 'in', t.amount, -t.amount) END), 0) AS reconciled_movement,
       COALESCE(SUM(CASE WHEN t.status = 'recorded' AND t.direction = 'in' THEN t.amount END), 0) AS total_in,
       COALESCE(SUM(CASE WHEN t.status = 'recorded' AND t.direction = 'out' THEN t.amount END), 0) AS total_out
     FROM treasury_accounts a LEFT JOIN treasury_transactions t ON t.account_id = a.id WHERE a.company_id = ? ${accountIds ? 'AND a.id IN (?)' : ''} GROUP BY a.id, a.opening_balance`,
    accountIds ? [companyId, accountIds] : [companyId]);
  return new Map(rows.map((r) => [Number(r.id), { balance: addSigned(r.opening_balance, r.movement), reconciledBalance: addSigned(r.opening_balance, r.reconciled_movement), totalIn: r.total_in, totalOut: r.total_out }]));
}

// Rattachement d'un règlement (client ou fournisseur) à la trésorerie.
// - chèque / effet : un instrument « en attente » est créé ; l'argent n'entre/sort du compte qu'à l'encaissement/au débit.
// - autres modes avec un compte : écriture immédiate ; sans compte : règlement non suivi en trésorerie.
export async function linkPayment(conn, ctx, { type, payment, accountId, dueDate, bankName }) {
  const direction = type === 'client_payment' ? 'in' : 'out';
  let account = null;
  if (accountId) {
    account = await findAccount(conn, ctx.companyId, accountId);
    if (account.currency !== payment.currency) throw new HttpError(422, 'CURRENCY_MISMATCH', `Le compte « ${account.name} » est en ${account.currency}, le règlement en ${payment.currency}`);
  }
  const instrumentType = INSTRUMENT_METHODS[payment.method];
  if (instrumentType) {
    await conn.query('INSERT INTO treasury_instruments (public_id, company_id, direction, type, instrument_number, bank_name, party_name, amount, currency, due_date, account_id, payment_type, payment_id, payment_number, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [newPublicId(), ctx.companyId, direction === 'in' ? 'received' : 'issued', instrumentType, payment.reference ?? null, bankName ?? null, payment.partyName, payment.amount, payment.currency, dueDate ?? payment.date, account?.id ?? null, type, payment.publicId, payment.number, ctx.userId]);
    return account?.id ?? null;
  }
  if (account) {
    await addTransaction(conn, ctx, { account, date: payment.date, direction, amount: payment.amount, kind: type, label: `${direction === 'in' ? 'Encaissement' : 'Règlement'} ${payment.number} — ${payment.partyName}`, reference: payment.reference, sourceType: type, sourceId: payment.publicId });
  }
  return account?.id ?? null;
}

async function cancelTx(conn, where, params, reason) {
  const [txs] = await conn.query(`SELECT id, number, reconciled FROM treasury_transactions WHERE company_id = ? AND status = 'recorded' AND ${where} FOR UPDATE`, params);
  const locked = txs.find((t) => t.reconciled);
  if (locked) throw new HttpError(409, 'RECONCILED', `L'écriture ${locked.number} est rapprochée : annulez le rapprochement avant d'annuler le règlement`);
  for (const t of txs) await conn.query("UPDATE treasury_transactions SET status = 'cancelled', cancel_reason = ?, cancelled_at = UTC_TIMESTAMP() WHERE id = ?", [reason, t.id]);
  return txs.length;
}

// Annulation d'un règlement : écritures et instruments liés annulés (jamais supprimés).
export async function unlinkPayment(conn, ctx, { type, publicId, reason }) {
  await cancelTx(conn, 'source_type = ? AND source_id = ?', [ctx.companyId, type, publicId], reason);
  const [ins] = await conn.query("SELECT id, public_id FROM treasury_instruments WHERE company_id = ? AND payment_type = ? AND payment_id = ? AND status IN ('pending','deposited','cleared') FOR UPDATE", [ctx.companyId, type, publicId]);
  for (const i of ins) {
    await cancelTx(conn, "source_type = 'instrument' AND source_id = ?", [ctx.companyId, i.public_id], reason);
    await conn.query("UPDATE treasury_instruments SET status = 'cancelled' WHERE id = ?", [i.id]);
  }
}
export { findAccountById, subMoney };
