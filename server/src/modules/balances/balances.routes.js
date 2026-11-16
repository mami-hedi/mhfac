// Soldes en temps réel : ce que l'on doit à chaque fournisseur / ce que chaque client nous doit.
// Calculé à chaque appel à partir des factures, avoirs et règlements enregistrés (aucune valeur stockée), par devise,
// avec les montants en DECIMAL(15,3) sommés côté serveur. company_id vient toujours de la session.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { EXPORT_MAX, PAGE_SIZE } from '../../core/list.js';
import { toCsv } from '../../core/csv.js';
import { audit } from '../../core/audit.js';
import { toScaled, fromScaled } from '../../core/calc.js';
import { sendCsv, csvMoney, csvDate, isExport } from '../../core/list-filters.js';
import { todayTunis } from '../sales/common.js';

const SIDES = {
  supplier: { inv: 'purchase_invoices', party: 'suppliers', fk: 'supplier_id', open: 'recorded', pay: 'supplier_payments', alloc: 'supplier_payment_allocations', perm: 'purchase.read',
    label: 'Fournisseur', owe: 'Dû au fournisseur', file: 'soldes-fournisseurs', stmtFile: 'releve-fournisseur', refCol: 'd.supplier_ref' },
  client: { inv: 'invoices', party: 'clients', fk: 'client_id', open: 'issued', pay: 'payments', alloc: 'payment_allocations', perm: 'invoice.read',
    label: 'Client', owe: 'Dû par le client', file: 'creances-clients', stmtFile: 'releve-client', refCol: 'NULL' },
};
const M = (n) => fromScaled(n, 3);
const sc = (v) => toScaled(v ?? '0', 3);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const idParam = z.object({ id: z.string().uuid() });

const LIST_Q = z.object({
  q: z.string().trim().max(100).optional(), currency: z.string().trim().length(3).toUpperCase().optional(),
  overdueOnly: z.enum(['true', 'false']).optional(), minAmount: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/).optional(),
  sort: z.enum(['name', 'total', 'overdue', 'net', 'oldest']).default('total'), order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE),
});
const STMT_Q = z.object({ currency: z.string().trim().length(3).toUpperCase().optional(), from: day.optional(), to: day.optional() });

/** Toutes les lignes (tiers × devise) avec leurs soldes. */
export async function computeBalances(side, companyId, today = todayTunis()) {
  const S = SIDES[side]; const t = pool.escape(today);
  const [open] = await pool.query(`SELECT x.party_id, x.currency, COUNT(*) AS open_count, SUM(x.bal) AS total,
      SUM(IF(x.due >= ${t}, x.bal, 0)) AS not_due,
      SUM(IF(DATEDIFF(${t}, x.due) BETWEEN 1 AND 30, x.bal, 0)) AS d30, SUM(IF(DATEDIFF(${t}, x.due) BETWEEN 31 AND 60, x.bal, 0)) AS d60,
      SUM(IF(DATEDIFF(${t}, x.due) BETWEEN 61 AND 90, x.bal, 0)) AS d90, SUM(IF(DATEDIFF(${t}, x.due) > 90, x.bal, 0)) AS d90p,
      DATE_FORMAT(MIN(IF(x.due < ${t}, x.due, NULL)), '%Y-%m-%d') AS oldest_overdue
    FROM (SELECT d.${S.fk} AS party_id, d.currency, COALESCE(d.due_date, d.issue_date) AS due,
            GREATEST(d.net_payable - d.paid_amount - COALESCE(cr.t, 0), 0) AS bal
          FROM ${S.inv} d
          LEFT JOIN (SELECT credited_invoice_id, SUM(net_payable) AS t FROM ${S.inv} WHERE company_id = ? AND kind = 'credit_note' AND status = ? GROUP BY credited_invoice_id) cr ON cr.credited_invoice_id = d.id
          WHERE d.company_id = ? AND d.kind = 'invoice' AND d.status = ?) x
    WHERE x.bal > 0 GROUP BY x.party_id, x.currency`, [companyId, S.open, companyId, S.open]);
  const [adv] = await pool.query(`SELECT p.${S.fk} AS party_id, p.currency, SUM(p.amount - COALESCE(a.t, 0)) AS advances, DATE_FORMAT(MAX(p.payment_date), '%Y-%m-%d') AS last_payment
    FROM ${S.pay} p LEFT JOIN (SELECT payment_id, SUM(amount) AS t FROM ${S.alloc} GROUP BY payment_id) a ON a.payment_id = p.id
    WHERE p.company_id = ? AND p.status = 'recorded' GROUP BY p.${S.fk}, p.currency`, [companyId]);
  const [parties] = await pool.query(`SELECT id, public_id, name FROM ${S.party} WHERE company_id = ?`, [companyId]);
  const byId = new Map(parties.map((p) => [p.id, p])); const rows = new Map();
  const key = (r) => `${r.party_id}|${r.currency}`;
  for (const r of open) rows.set(key(r), { party_id: r.party_id, currency: r.currency, openCount: Number(r.open_count), total: sc(r.total), notDue: sc(r.not_due), d30: sc(r.d30), d60: sc(r.d60), d90: sc(r.d90), d90p: sc(r.d90p), oldestOverdue: r.oldest_overdue, advances: 0n, lastPayment: null });
  for (const r of adv) {
    const k = key(r); const cur = rows.get(k) ?? { party_id: r.party_id, currency: r.currency, openCount: 0, total: 0n, notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90p: 0n, oldestOverdue: null, advances: 0n, lastPayment: null };
    cur.advances = sc(r.advances); cur.lastPayment = r.last_payment; rows.set(k, cur);
  }
  return [...rows.values()].filter((r) => byId.has(r.party_id) && (r.total !== 0n || r.advances !== 0n)).map((r) => {
    const p = byId.get(r.party_id); const overdue = r.d30 + r.d60 + r.d90 + r.d90p;
    return { ...r, id: p.public_id, name: p.name, overdue, net: r.total - r.advances };
  });
}
const dto = (r) => ({ id: r.id, name: r.name, currency: r.currency, openInvoices: r.openCount, total: M(r.total), notDue: M(r.notDue), overdue: M(r.overdue),
  aging: { d1_30: M(r.d30), d31_60: M(r.d60), d61_90: M(r.d90), over90: M(r.d90p) }, advances: M(r.advances), net: M(r.net), oldestOverdue: r.oldestOverdue, lastPayment: r.lastPayment });

function filterSort(rows, q) {
  let out = rows;
  if (q.q) { const n = q.q.toLowerCase(); out = out.filter((r) => r.name.toLowerCase().includes(n)); }
  if (q.currency) out = out.filter((r) => r.currency === q.currency);
  if (q.overdueOnly === 'true') out = out.filter((r) => r.overdue > 0n);
  if (q.minAmount) { const m = sc(q.minAmount); out = out.filter((r) => r.total >= m); }
  const dir = q.order === 'asc' ? 1 : -1;
  const val = { name: (r) => r.name.toLowerCase(), total: (r) => r.total, overdue: (r) => r.overdue, net: (r) => r.net, oldest: (r) => r.oldestOverdue ?? '9999-12-31' }[q.sort];
  return [...out].sort((a, b) => { const x = val(a); const y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name) || a.currency.localeCompare(b.currency); });
}
function totalsByCurrency(rows) {
  const m = new Map();
  for (const r of rows) { const t = m.get(r.currency) ?? { currency: r.currency, parties: 0, total: 0n, overdue: 0n, advances: 0n, net: 0n }; t.parties += 1; t.total += r.total; t.overdue += r.overdue; t.advances += r.advances; t.net += r.net; m.set(r.currency, t); }
  return [...m.values()].map((t) => ({ currency: t.currency, parties: t.parties, total: M(t.total), overdue: M(t.overdue), advances: M(t.advances), net: M(t.net) }));
}

async function partyOf(side, companyId, publicId) {
  const S = SIDES[side];
  const [[p]] = await pool.query(`SELECT id, public_id, name FROM ${S.party} WHERE company_id = ? AND public_id = ?`, [companyId, publicId]);
  if (!p) throw new HttpError(404, 'NOT_FOUND', `${S.label} introuvable`);
  return p;
}

/** Mouvements chronologiques (relevé de compte) avec solde cumulé. charge = augmente la dette, settlement = la diminue. */
export async function statement(side, companyId, party, { currency, from, to }) {
  const S = SIDES[side];
  const [mv] = await pool.query(`
    SELECT 'invoice' AS type, 1 AS ord, d.id AS n, d.public_id AS id, d.number AS ref, ${S.refCol} AS extref, DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS dt, d.net_payable AS charge, 0 AS settlement FROM ${S.inv} d WHERE d.company_id = ? AND d.${S.fk} = ? AND d.currency = ? AND d.kind = 'invoice' AND d.status = ?
    UNION ALL SELECT 'credit_note', 2, d.id, d.public_id, d.number, ${S.refCol}, DATE_FORMAT(d.issue_date,'%Y-%m-%d'), 0, d.net_payable FROM ${S.inv} d WHERE d.company_id = ? AND d.${S.fk} = ? AND d.currency = ? AND d.kind = 'credit_note' AND d.status = ?
    UNION ALL SELECT 'payment', 3, p.id, p.public_id, p.number, NULL, DATE_FORMAT(p.payment_date,'%Y-%m-%d'), 0, p.amount FROM ${S.pay} p WHERE p.company_id = ? AND p.${S.fk} = ? AND p.currency = ? AND p.status = 'recorded'
    ORDER BY dt, ord, n`, [companyId, party.id, currency, S.open, companyId, party.id, currency, S.open, companyId, party.id, currency]);
  let bal = 0n; let opening = 0n; const lines = [];
  for (const m of mv) {
    const delta = sc(m.charge) - sc(m.settlement);
    if (from && m.dt < from) { opening += delta; bal += delta; continue; }
    if (to && m.dt > to) continue;
    bal += delta; lines.push({ type: m.type, id: m.id, ref: m.ref, supplierRef: m.extref ?? null, date: m.dt, charge: M(sc(m.charge)), settlement: M(sc(m.settlement)), balance: M(bal) });
  }
  return { currency, opening: M(opening), closing: M(bal), lines };
}

export function balancesRouter(side) {
  const S = SIDES[side]; const router = Router(); router.use(authenticate);
  const read = requirePermission(S.perm);

  router.get(['/', '/export'], read, validate({ query: LIST_Q }), asyncHandler(async (req, res) => {
    const all = filterSort(await computeBalances(side, req.auth.companyId), req.query);
    if (isExport(req)) {
      const rows = all.slice(0, EXPORT_MAX);
      const head = [S.label, 'Devise', 'Factures ouvertes', 'Total dû', 'Non échu', 'Échu 1-30 j', 'Échu 31-60 j', 'Échu 61-90 j', 'Échu +90 j', 'Avances non affectées', 'Solde net', 'Plus ancienne échéance dépassée', 'Dernier règlement'];
      const text = toCsv(head, rows.map((r) => { const d = dto(r); return [d.name, d.currency, d.openInvoices, csvMoney(d.total), csvMoney(d.notDue), csvMoney(d.aging.d1_30), csvMoney(d.aging.d31_60), csvMoney(d.aging.d61_90), csvMoney(d.aging.over90), csvMoney(d.advances), csvMoney(d.net), csvDate(d.oldestOverdue), csvDate(d.lastPayment)]; }));
      await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${side}_balances.export`, entityType: S.party, entityId: null, ip: req.ip, meta: { rows: rows.length } });
      return sendCsv(res, `${S.file}-${todayTunis()}.csv`, text, { total: all.length, shown: rows.length });
    }
    const { page, limit } = req.query; const start = (page - 1) * limit;
    res.json({ data: all.slice(start, start + limit).map(dto), meta: { page, limit, total: all.length, pages: Math.max(1, Math.ceil(all.length / limit)), asOf: todayTunis(), totals: totalsByCurrency(all) } });
  }));

  // Détail d'un tiers : factures ouvertes + règlements non affectés
  router.get('/:id', read, validate({ params: idParam }), asyncHandler(async (req, res) => {
    const cid = req.auth.companyId; const party = await partyOf(side, cid, req.params.id); const today = todayTunis();
    const [inv] = await pool.query(`SELECT d.public_id, d.number, ${S.refCol} AS extref, d.currency, DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS issue_date, DATE_FORMAT(COALESCE(d.due_date,d.issue_date),'%Y-%m-%d') AS due_date, d.net_payable, d.paid_amount,
        COALESCE(cr.t,0) AS credited FROM ${S.inv} d
      LEFT JOIN (SELECT credited_invoice_id, SUM(net_payable) AS t FROM ${S.inv} WHERE company_id = ? AND kind = 'credit_note' AND status = ? GROUP BY credited_invoice_id) cr ON cr.credited_invoice_id = d.id
      WHERE d.company_id = ? AND d.${S.fk} = ? AND d.kind = 'invoice' AND d.status = ? ORDER BY d.due_date, d.id`, [cid, S.open, cid, party.id, S.open]);
    const invoices = inv.map((d) => { const bal = sc(d.net_payable) - sc(d.paid_amount) - sc(d.credited); return { d, bal: bal < 0n ? 0n : bal }; }).filter((x) => x.bal > 0n).map(({ d, bal }) => ({
      id: d.public_id, number: d.number, supplierRef: d.extref ?? null, currency: d.currency, issueDate: d.issue_date, dueDate: d.due_date, netPayable: M(sc(d.net_payable)), paid: M(sc(d.paid_amount)), credited: M(sc(d.credited)), balance: M(bal),
      overdue: d.due_date < today, daysOverdue: d.due_date < today ? Math.round((Date.parse(today) - Date.parse(d.due_date)) / 86400000) : 0 }));
    const [pays] = await pool.query(`SELECT p.public_id, p.number, p.currency, DATE_FORMAT(p.payment_date,'%Y-%m-%d') AS dt, p.amount - COALESCE(a.t,0) AS unallocated FROM ${S.pay} p
      LEFT JOIN (SELECT payment_id, SUM(amount) AS t FROM ${S.alloc} GROUP BY payment_id) a ON a.payment_id = p.id
      WHERE p.company_id = ? AND p.${S.fk} = ? AND p.status = 'recorded' AND p.amount - COALESCE(a.t,0) > 0 ORDER BY p.payment_date, p.id`, [cid, party.id]);
    const summary = (await computeBalances(side, cid, today)).filter((r) => r.party_id === party.id).map(dto);
    res.json({ data: { party: { id: party.public_id, name: party.name }, summary, invoices, unallocatedPayments: pays.map((p) => ({ id: p.public_id, number: p.number, currency: p.currency, date: p.dt, amount: M(sc(p.unallocated)) })) }, meta: { asOf: today } });
  }));

  router.get(['/:id/statement', '/:id/statement/export'], read, validate({ params: idParam, query: STMT_Q }), asyncHandler(async (req, res) => {
    const cid = req.auth.companyId; const party = await partyOf(side, cid, req.params.id);
    const [[co]] = await pool.query('SELECT currency FROM companies WHERE id = ?', [cid]);
    const q = req.query; if (q.from && q.to && q.from > q.to) throw new HttpError(422, 'INVALID_RANGE', 'La date de début dépasse la date de fin');
    const st = await statement(side, cid, party, { currency: q.currency ?? co?.currency ?? 'TND', from: q.from, to: q.to });
    if (req.path.endsWith('/export')) {
      const head = ['Date', 'Type', 'Pièce', 'Réf. externe', 'Augmente la dette', 'Diminue la dette', 'Solde cumulé'];
      const TYPE = { invoice: 'Facture', credit_note: 'Avoir', payment: 'Règlement' };
      const rows = [['', 'Solde initial', '', '', '', '', csvMoney(st.opening)], ...st.lines.map((l) => [csvDate(l.date), TYPE[l.type], l.ref, l.supplierRef ?? '', csvMoney(l.charge), csvMoney(l.settlement), csvMoney(l.balance)])];
      await audit(null, { companyId: cid, userId: req.auth.userId, action: `${side}_statement.export`, entityType: S.party, entityId: party.public_id, ip: req.ip, meta: { currency: st.currency, rows: rows.length } });
      return sendCsv(res, `${S.stmtFile}-${String(party.name).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}-${todayTunis()}.csv`, toCsv(head, rows), { total: rows.length, shown: rows.length });
    }
    res.json({ data: { party: { id: party.public_id, name: party.name }, ...st }, meta: { asOf: todayTunis() } });
  }));
  return router;
}
