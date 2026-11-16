// Tableau de bord : indicateurs et graphiques calculés côté serveur depuis les données réelles (jamais de chiffre statique).
// Chaque indicateur n'est renvoyé que si le rôle a le droit de lire le module source. Montants en devise de l'entreprise
// (montant × taux du document, arrondi au millime) ; avoirs en négatif ; brouillons et documents annulés exclus.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { balances } from '../treasury/treasury.service.js';
import { sc, fmt3 } from '../reports/util.js';
import { todayTunis } from '../sales/common.js';

const router = Router();
router.use(authenticate);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const SGN = "IF(d.kind = 'credit_note', -1, 1)";
const BAL_S = "(d.net_payable - d.paid_amount - (SELECT COALESCE(SUM(cn.net_payable),0) FROM invoices cn WHERE cn.credited_invoice_id = d.id AND cn.kind = 'credit_note' AND cn.status = 'issued'))";
const BAL_P = "(d.net_payable - d.paid_amount - (SELECT COALESCE(SUM(cn.net_payable),0) FROM purchase_invoices cn WHERE cn.credited_invoice_id = d.id AND cn.kind = 'credit_note' AND cn.status = 'recorded'))";
const addMonths = (isoDate, n) => { const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

router.get('/summary', validate({ query: z.object({ from: iso.optional(), to: iso.optional() }) }), asyncHandler(async (req, res) => {
  const { companyId, permissions: P } = req.auth; const today = todayTunis();
  const from = req.query.from ?? `${today.slice(0, 4)}-01-01`; const to = req.query.to ?? today;
  const [[co]] = await pool.query('SELECT currency FROM companies WHERE id = ?', [companyId]);
  let team = null;
  if (P.has('user.read')) {
    const [[m]] = await pool.query("SELECT COUNT(*) n FROM company_members WHERE company_id = ? AND status = 'active'", [companyId]);
    const [[i]] = await pool.query('SELECT COUNT(*) n FROM invitations WHERE company_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', [companyId, new Date()]);
    team = { members: Number(m.n), pendingInvitations: Number(i.n) };
  }
  const kpis = {}; const charts = {};
  const q = async (sql, params) => (await pool.query(sql, params))[0];

  if (P.has('invoice.read')) {
    const [r] = await q(`SELECT COALESCE(SUM(ROUND(d.total_ht * d.exchange_rate, 3) * ${SGN}),0) AS ht, COUNT(*) AS n FROM invoices d WHERE d.company_id = ? AND d.status = 'issued' AND d.issue_date BETWEEN ? AND ?`, [companyId, from, to]);
    kpis.revenue = { value: fmt3(sc(r.ht)), count: Number(r.n), unit: co.currency };
    const [u] = await q(`SELECT COUNT(*) AS n, COUNT(DISTINCT d.client_id) AS clients, COALESCE(SUM(ROUND(${BAL_S} * d.exchange_rate, 3)),0) AS total,
        COALESCE(SUM(IF(d.due_date < ?, 1, 0)),0) AS late_n, COALESCE(SUM(IF(d.due_date < ?, ROUND(${BAL_S} * d.exchange_rate, 3), 0)),0) AS late_total
      FROM invoices d WHERE d.company_id = ? AND d.kind = 'invoice' AND d.status = 'issued' AND ${BAL_S} > 0`, [today, today, companyId]);
    kpis.unpaid = { value: fmt3(sc(u.total)), count: Number(u.n), unit: co.currency };
    kpis.overdue = { value: fmt3(sc(u.late_total)), count: Number(u.late_n), unit: co.currency };
    kpis.client_balances = { value: fmt3(sc(u.total)), count: Number(u.clients), unit: co.currency };
    // Évolution du CA : 12 derniers mois glissants (indépendant du filtre de période)
    const start = addMonths(today, -11);
    const rows = await q(`SELECT DATE_FORMAT(d.issue_date,'%Y-%m') AS m, SUM(ROUND(d.total_ht * d.exchange_rate, 3) * ${SGN}) AS ht FROM invoices d WHERE d.company_id = ? AND d.status = 'issued' AND d.issue_date >= ? GROUP BY m`, [companyId, start]);
    charts.revenueTrend = Array.from({ length: 12 }, (_, i) => { const m = addMonths(today, -11 + i).slice(0, 7); return { label: m, value: fmt3(sc(rows.find((x) => x.m === m)?.ht)) }; });
    const byClient = await q(`SELECT c.name AS label, SUM(ROUND(d.total_ht * d.exchange_rate, 3) * ${SGN}) AS v FROM invoices d JOIN clients c ON c.id = d.client_id WHERE d.company_id = ? AND d.status = 'issued' AND d.issue_date BETWEEN ? AND ? GROUP BY c.id, c.name HAVING v > 0 ORDER BY v DESC`, [companyId, from, to]);
    const top = byClient.slice(0, 5).map((r) => ({ label: r.label, value: fmt3(sc(r.v)) })); const rest = byClient.slice(5).reduce((s, r) => s + sc(r.v), 0n);
    charts.salesByClient = rest > 0n ? [...top, { label: 'Autres clients', value: fmt3(rest) }] : top;
    const [pv] = await q(`SELECT COALESCE(SUM(ROUND(LEAST(d.paid_amount, d.net_payable) * d.exchange_rate, 3)),0) AS paid, COALESCE(SUM(ROUND(GREATEST(${BAL_S}, 0) * d.exchange_rate, 3)),0) AS unpaid FROM invoices d WHERE d.company_id = ? AND d.kind = 'invoice' AND d.status = 'issued' AND d.issue_date BETWEEN ? AND ?`, [companyId, from, to]);
    charts.paidVsUnpaid = [{ label: 'Payé', value: fmt3(sc(pv.paid)) }, { label: 'Impayé', value: fmt3(sc(pv.unpaid)) }];
    const tp = await q(`SELECT COALESCE(pr.name, l.description) AS label, SUM(ROUND(l.net_amount * d.exchange_rate, 3) * ${SGN}) AS v FROM invoice_lines l JOIN invoices d ON d.id = l.invoice_id LEFT JOIN products pr ON pr.id = l.product_id
      WHERE d.company_id = ? AND d.status = 'issued' AND d.issue_date BETWEEN ? AND ? GROUP BY COALESCE(CAST(l.product_id AS CHAR), l.description), COALESCE(pr.name, l.description) HAVING v > 0 ORDER BY v DESC LIMIT 5`, [companyId, from, to]);
    charts.topProducts = tp.map((r) => ({ label: r.label, value: fmt3(sc(r.v)) }));
  }
  if (P.has('payment.read')) {
    const [r] = await q("SELECT COALESCE(SUM(x.amount),0) AS t, COUNT(*) AS n FROM payments x JOIN companies co ON co.id = x.company_id WHERE x.company_id = ? AND x.status = 'recorded' AND x.method <> 'withholding' AND x.currency = co.currency AND x.payment_date BETWEEN ? AND ?", [companyId, from, to]);
    kpis.collected = { value: fmt3(sc(r.t)), count: Number(r.n), unit: co.currency };
  }
  if (P.has('quote.read')) {
    const [r] = await q(`SELECT SUM(status = 'sent') AS pending, SUM(status = 'converted') AS converted, SUM(status IN ('sent','accepted','refused','converted')) AS decided FROM quotes WHERE company_id = ? AND issue_date BETWEEN ? AND ?`, [companyId, from, to]);
    const [pend] = await q("SELECT COUNT(*) AS n FROM quotes WHERE company_id = ? AND status = 'sent' AND (valid_until IS NULL OR valid_until >= ?)", [companyId, today]);
    kpis.pending_quotes = { value: String(pend.n), count: Number(pend.n) };
    kpis.quote_conversion = { value: Number(r.decided) > 0 ? ((Number(r.converted) / Number(r.decided)) * 100).toFixed(1) : null, count: Number(r.decided), converted: Number(r.converted), unit: '%' };
  }
  if (P.has('purchase.read')) {
    const [e] = await q(`SELECT COALESCE(SUM(ROUND(d.total_ht * d.exchange_rate, 3) * ${SGN}),0) AS t, COUNT(*) AS n FROM purchase_invoices d WHERE d.company_id = ? AND d.status = 'recorded' AND d.issue_date BETWEEN ? AND ?`, [companyId, from, to]);
    kpis.expenses = { value: fmt3(sc(e.t)), count: Number(e.n), unit: co.currency };
    const [s] = await q(`SELECT COUNT(DISTINCT d.supplier_id) AS suppliers, COALESCE(SUM(ROUND(${BAL_P} * d.exchange_rate, 3)),0) AS total FROM purchase_invoices d WHERE d.company_id = ? AND d.kind = 'invoice' AND d.status = 'recorded' AND ${BAL_P} > 0`, [companyId]);
    kpis.supplier_balances = { value: fmt3(sc(s.total)), count: Number(s.suppliers), unit: co.currency };
    const cat = await q(`SELECT COALESCE(pc.name, 'Sans catégorie') AS label, SUM(ROUND(l.net_amount * d.exchange_rate, 3) * ${SGN}) AS v FROM purchase_invoice_lines l JOIN purchase_invoices d ON d.id = l.purchase_invoice_id LEFT JOIN products pr ON pr.id = l.product_id LEFT JOIN product_categories pc ON pc.id = pr.category_id
      WHERE d.company_id = ? AND d.status = 'recorded' AND d.issue_date BETWEEN ? AND ? GROUP BY label HAVING v > 0 ORDER BY v DESC LIMIT 8`, [companyId, from, to]);
    charts.expensesByCategory = cat.map((r) => ({ label: r.label, value: fmt3(sc(r.v)) }));
  }
  if (P.has('treasury.read')) {
    const accs = await q("SELECT id, currency FROM treasury_accounts WHERE company_id = ? AND status = 'active'", [companyId]);
    const bal = await balances(pool, companyId, accs.map((a) => a.id)); const byCur = {};
    for (const a of accs) { const b = bal.get(Number(a.id)); byCur[a.currency] = (byCur[a.currency] ?? 0n) + sc(b?.balance); }
    const main = byCur[co.currency] ?? 0n;
    kpis.treasury = { value: fmt3(main), count: accs.length, unit: co.currency, other: Object.entries(byCur).filter(([c]) => c !== co.currency).map(([c, v]) => ({ unit: c, value: fmt3(v) })) };
  }
  if (P.has('stock.read')) {
    const low = await q(`SELECT pr.public_id AS id, pr.name, pr.stock_alert_threshold AS threshold, COALESCE(SUM(sl.quantity),0) AS qty FROM products pr LEFT JOIN stock_levels sl ON sl.product_id = pr.id
      WHERE pr.company_id = ? AND pr.track_stock = 1 AND pr.status = 'active' AND pr.stock_alert_threshold IS NOT NULL GROUP BY pr.id HAVING qty <= pr.stock_alert_threshold ORDER BY qty ASC LIMIT 20`, [companyId]);
    kpis.low_stock = { value: String(low.length), count: low.length, items: low.slice(0, 5).map((r) => ({ id: r.id, name: r.name, quantity: String(Number(r.qty)), threshold: String(Number(r.threshold)) })) };
  }
  res.json({ data: { period: { from, to }, currency: co.currency, team, kpis, charts, note: "Indicateurs de gestion calculés depuis vos documents (brouillons et annulés exclus, avoirs déduits) ; ils ne constituent pas une comptabilité certifiée." } });
}));

export default router;
