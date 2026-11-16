// Définitions des rapports de gestion. Toutes les requêtes sont filtrées par company_id (issu de la session).
// Montants en devise de l'entreprise : montant du document × taux de change du document, arrondi au millime.
// Avoirs en négatif. Seuls les documents émis (ventes) / enregistrés (achats) comptent : brouillons et annulés exclus.
import { pool } from '../../config/db.js';
import { sc, fmt3, sumCol, MAX_ROWS } from './util.js';
import { HttpError } from '../../utils/httpError.js';

const SGN = "IF(d.kind = 'credit_note', -1, 1)";
const T = (col, fx = 'd.exchange_rate') => `ROUND(${col} * ${fx}, 3) * ${SGN}`;
const BAL_S = "(d.net_payable - d.paid_amount - (SELECT COALESCE(SUM(cn.net_payable),0) FROM invoices cn WHERE cn.credited_invoice_id = d.id AND cn.kind = 'credit_note' AND cn.status = 'issued'))";
const BAL_P = "(d.net_payable - d.paid_amount - (SELECT COALESCE(SUM(cn.net_payable),0) FROM purchase_invoices cn WHERE cn.credited_invoice_id = d.id AND cn.kind = 'credit_note' AND cn.status = 'recorded'))";
const BUCKETS = [['notDue', 'Non échu'], ['d30', '1-30 j'], ['d60', '31-60 j'], ['d90', '61-90 j'], ['d90p', '> 90 j']];
const bucketOf = (days) => (days <= 0 ? 'notDue' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'd90p');
const cap = (rows) => { if (rows.length > MAX_ROWS) throw new HttpError(422, 'TOO_MANY_ROWS', `Plus de ${MAX_ROWS} lignes : réduisez la période ou ajoutez un filtre`); return rows; };
const col = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const totals = (rows, keys) => Object.fromEntries(keys.map((k) => [k, sumCol(rows, k)]));
const NOTE_FX = "Montants en devise de l'entreprise (montant du document × taux de change du document). Avoirs en négatif.";

// p = { companyId, from, to, asOf, clientId, supplierId, productId, warehouseId, groupBy, overdueOnly }
export const REPORTS = {
  sales: {
    title: 'Rapport des ventes', group: 'Ventes', needs: ['invoice.read'], filters: ['period', 'client'], note: NOTE_FX,
    async run(p) {
      const w = ["d.company_id = ?", "d.status = 'issued'", 'd.issue_date BETWEEN ? AND ?']; const a = [p.companyId, p.from, p.to];
      if (p.clientId) { w.push('c.public_id = ?'); a.push(p.clientId); }
      const [rows] = await pool.query(`SELECT DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS date, d.number, IF(d.kind='credit_note','Avoir','Facture') AS type, c.name AS party, c.tax_id AS taxId, d.currency,
          ${T('d.total_ht')} AS ht, ${T('d.fodec_amount')} AS fodec, ${T('d.total_tax')} AS tax, ${T('d.stamp_duty')} AS stamp, ${T('d.total_ttc')} AS ttc, ${T('d.withholding_amount')} AS withholding, ${T('d.net_payable')} AS net
        FROM invoices d JOIN clients c ON c.id = d.client_id WHERE ${w.join(' AND ')} ORDER BY d.issue_date, d.id`, a);
      cap(rows);
      return { columns: [col('date', 'Date', 'date'), col('number', 'N°'), col('type', 'Type'), col('party', 'Client'), col('taxId', 'MF'), col('currency', 'Devise'), col('ht', 'Total HT', 'money'), col('fodec', 'FODEC', 'money'), col('tax', 'TVA', 'money'), col('stamp', 'Timbre', 'money'), col('ttc', 'Total TTC', 'money'), col('withholding', 'Retenue', 'money'), col('net', 'Net à payer', 'money')],
        rows, totals: totals(rows, ['ht', 'fodec', 'tax', 'stamp', 'ttc', 'withholding', 'net']) };
    },
  },
  purchases: {
    title: 'Rapport des achats', group: 'Achats', needs: ['purchase.read'], filters: ['period', 'supplier'], note: NOTE_FX,
    async run(p) {
      const w = ["d.company_id = ?", "d.status = 'recorded'", 'd.issue_date BETWEEN ? AND ?']; const a = [p.companyId, p.from, p.to];
      if (p.supplierId) { w.push('s.public_id = ?'); a.push(p.supplierId); }
      const [rows] = await pool.query(`SELECT DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS date, d.number, d.supplier_ref AS ref, IF(d.kind='credit_note','Avoir','Facture') AS type, s.name AS party, d.currency,
          ${T('d.total_ht')} AS ht, ${T('d.total_tax')} AS tax, ${T('d.total_ttc')} AS ttc, ${T('d.withholding_amount')} AS withholding, ${T('d.net_payable')} AS net
        FROM purchase_invoices d JOIN suppliers s ON s.id = d.supplier_id WHERE ${w.join(' AND ')} ORDER BY d.issue_date, d.id`, a);
      cap(rows);
      return { columns: [col('date', 'Date', 'date'), col('number', 'N° interne'), col('ref', 'Réf. fournisseur'), col('type', 'Type'), col('party', 'Fournisseur'), col('currency', 'Devise'), col('ht', 'Total HT', 'money'), col('tax', 'TVA', 'money'), col('ttc', 'Total TTC', 'money'), col('withholding', 'Retenue', 'money'), col('net', 'Net à payer', 'money')],
        rows, totals: totals(rows, ['ht', 'tax', 'ttc', 'withholding', 'net']) };
    },
  },
  vat: {
    title: 'Rapport de TVA', group: 'Fiscalité', needs: ['invoice.read', 'purchase.read'], filters: ['period'],
    note: "La base de TVA des ventes inclut le FODEC (HT + FODEC). TVA calculée sur la date de facturation (factures émises / enregistrées), par taux. Rapport de gestion : ne remplace pas la déclaration de TVA ; à valider avec votre comptable.",
    async run(p) {
      const [s] = await pool.query(`SELECT t.tax_rate AS rate, SUM(ROUND(t.base * d.exchange_rate, 3) * ${SGN}) AS base, SUM(ROUND(t.amount * d.exchange_rate, 3) * ${SGN}) AS vat
        FROM invoice_tax_lines t JOIN invoices d ON d.id = t.invoice_id WHERE d.company_id = ? AND d.status = 'issued' AND d.issue_date BETWEEN ? AND ? GROUP BY t.tax_rate`, [p.companyId, p.from, p.to]);
      const [b] = await pool.query(`SELECT t.tax_rate AS rate, SUM(ROUND(t.base * d.exchange_rate, 3) * ${SGN}) AS base, SUM(ROUND(t.amount * d.exchange_rate, 3) * ${SGN}) AS vat
        FROM purchase_invoice_tax_lines t JOIN purchase_invoices d ON d.id = t.purchase_invoice_id WHERE d.company_id = ? AND d.status = 'recorded' AND d.issue_date BETWEEN ? AND ? GROUP BY t.tax_rate`, [p.companyId, p.from, p.to]);
      const rates = [...new Set([...s, ...b].map((r) => Number(r.rate)))].sort((x, y) => x - y);
      const rows = rates.map((rate) => {
        const x = s.find((r) => Number(r.rate) === rate); const y = b.find((r) => Number(r.rate) === rate);
        const baseS = String(x?.base ?? '0.000'); const vatC = String(x?.vat ?? '0.000'); const baseP = String(y?.base ?? '0.000'); const vatD = String(y?.vat ?? '0.000');
        return { rate: `${rate} %`, baseSales: fmt3(sc(baseS)), vatCollected: fmt3(sc(vatC)), basePurchases: fmt3(sc(baseP)), vatDeductible: fmt3(sc(vatD)), balance: fmt3(sc(vatC) - sc(vatD)) };
      });
      return { columns: [col('rate', 'Taux TVA'), col('baseSales', 'Base ventes', 'money'), col('vatCollected', 'TVA collectée', 'money'), col('basePurchases', 'Base achats', 'money'), col('vatDeductible', 'TVA déductible', 'money'), col('balance', 'TVA à reverser (+) / crédit (−)', 'money')],
        rows, totals: totals(rows, ['baseSales', 'vatCollected', 'basePurchases', 'vatDeductible', 'balance']) };
    },
  },
  collections: {
    title: 'Rapport des encaissements', group: 'Trésorerie', needs: ['payment.read'], filters: ['period', 'client'], note: 'Règlements clients enregistrés (annulés exclus), dans la devise du règlement.',
    async run(p) {
      const w = ["x.company_id = ?", "x.status = 'recorded'", "x.method <> 'withholding'", 'x.payment_date BETWEEN ? AND ?']; const a = [p.companyId, p.from, p.to];
      if (p.clientId) { w.push('c.public_id = ?'); a.push(p.clientId); }
      const [rows] = await pool.query(`SELECT DATE_FORMAT(x.payment_date,'%Y-%m-%d') AS date, x.number, c.name AS party, x.method, x.reference, x.currency, x.amount FROM payments x JOIN clients c ON c.id = x.client_id WHERE ${w.join(' AND ')} ORDER BY x.payment_date, x.id`, a);
      cap(rows); const M = { cash: 'Espèces', bank_transfer: 'Virement', cheque: 'Chèque', card: 'Carte', bill_of_exchange: 'Effet', other: 'Autre' };
      rows.forEach((r) => { r.method = M[r.method] ?? r.method; });
      const byCur = {}; rows.forEach((r) => { byCur[r.currency] = (byCur[r.currency] ?? 0n) + sc(r.amount); });
      return { columns: [col('date', 'Date', 'date'), col('number', 'N°'), col('party', 'Client'), col('method', 'Mode'), col('reference', 'Référence'), col('currency', 'Devise'), col('amount', 'Montant', 'money')], rows,
        totals: Object.keys(byCur).length === 1 ? { amount: fmt3(Object.values(byCur)[0]) } : {}, extraTotals: Object.entries(byCur).map(([c, v]) => ({ label: `Total ${c}`, value: fmt3(v) })) };
    },
  },
  unpaid: {
    title: 'Rapport des impayés', group: 'Ventes', needs: ['invoice.read'], filters: ['asOf', 'client', 'overdue'], note: 'Factures émises dont le solde (net à payer − règlements − avoirs) est positif à la date choisie, en devise du document.',
    async run(p) {
      const w = ["d.company_id = ?", "d.kind = 'invoice'", "d.status = 'issued'", 'd.issue_date <= ?', `${BAL_S} > 0`]; const a = [p.companyId, p.asOf];
      if (p.clientId) { w.push('c.public_id = ?'); a.push(p.clientId); } if (p.overdueOnly) { w.push('d.due_date < ?'); a.push(p.asOf); }
      const [rows] = await pool.query(`SELECT d.number, c.name AS party, d.currency, DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS date, DATE_FORMAT(d.due_date,'%Y-%m-%d') AS due, GREATEST(DATEDIFF(?, d.due_date),0) AS daysLate, d.net_payable AS net, d.paid_amount AS paid, ${BAL_S} AS balance
        FROM invoices d JOIN clients c ON c.id = d.client_id WHERE ${w.join(' AND ')} ORDER BY d.due_date, d.id`, [p.asOf, ...a]);
      cap(rows); const byCur = {}; rows.forEach((r) => { byCur[r.currency] = (byCur[r.currency] ?? 0n) + sc(r.balance); });
      return { columns: [col('number', 'Facture'), col('party', 'Client'), col('date', 'Date', 'date'), col('due', 'Échéance', 'date'), col('daysLate', 'Jours de retard', 'number'), col('currency', 'Devise'), col('net', 'Net à payer', 'money'), col('paid', 'Réglé', 'money'), col('balance', 'Solde dû', 'money')], rows,
        totals: Object.keys(byCur).length === 1 ? { balance: fmt3(Object.values(byCur)[0]) } : {}, extraTotals: Object.entries(byCur).map(([c, v]) => ({ label: `Solde dû ${c}`, value: fmt3(v) })) };
    },
  },
  receivables: aging('receivables', 'Rapport des créances clients', 'Ventes', 'invoice.read', 'invoices', 'clients', 'client_id', "d.kind = 'invoice' AND d.status = 'issued'", BAL_S, 'Client'),
  payables: aging('payables', 'Rapport des dettes fournisseurs', 'Achats', 'purchase.read', 'purchase_invoices', 'suppliers', 'supplier_id', "d.kind = 'invoice' AND d.status = 'recorded'", BAL_P, 'Fournisseur'),
  stock_movements: {
    title: 'Rapport des mouvements de stock', group: 'Stock', needs: ['stock.read'], filters: ['period', 'product'], note: 'Journal des mouvements (jamais modifié) : quantités signées (+ entrée, − sortie), coûts au CMUP.',
    async run(p) {
      const w = ['m.company_id = ?', 'm.movement_date BETWEEN ? AND ?']; const a = [p.companyId, p.from, p.to];
      if (p.productId) { w.push('pr.public_id = ?'); a.push(p.productId); } if (p.warehouseId) { w.push('wh.public_id = ?'); a.push(p.warehouseId); }
      const [rows] = await pool.query(`SELECT DATE_FORMAT(m.movement_date,'%Y-%m-%d') AS date, pr.name AS product, pr.sku AS sku, wh.name AS warehouse, m.kind, m.quantity, m.unit_cost AS unitCost, m.total_cost AS totalCost, m.balance_after AS balanceAfter, m.source_number AS source, m.reason
        FROM stock_movements m JOIN products pr ON pr.id = m.product_id JOIN warehouses wh ON wh.id = m.warehouse_id WHERE ${w.join(' AND ')} ORDER BY m.movement_date, m.id`, a);
      cap(rows);
      const K = { entry: 'Entrée', withdrawal: 'Sortie', transfer_in: 'Transfert (entrée)', transfer_out: 'Transfert (sortie)', adjustment: 'Ajustement', inventory: 'Inventaire', delivery: 'Livraison', delivery_reversal: 'Annulation livraison', cancellation: 'Annulation', return_in: 'Retour client', return_out: 'Retour fournisseur' };
      rows.forEach((r) => { r.kind = K[r.kind] ?? r.kind; });
      return { columns: [col('date', 'Date', 'date'), col('product', 'Article'), col('sku', 'Réf.'), col('warehouse', 'Entrepôt'), col('kind', 'Type'), col('quantity', 'Quantité', 'qty'), col('unitCost', 'Coût unit.', 'qty'), col('totalCost', 'Valeur', 'money'), col('balanceAfter', 'Stock après', 'qty'), col('source', 'Document'), col('reason', 'Motif')], rows, totals: { totalCost: sumCol(rows, 'totalCost') } };
    },
  },
  revenue: {
    title: "Chiffre d'affaires par période", group: 'Ventes', needs: ['invoice.read'], filters: ['period', 'groupBy'], note: `${NOTE_FX} Encaissé = règlements enregistrés en devise de l'entreprise sur la période.`,
    async run(p) {
      const FMT = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y', week: '%x-S%v' }[p.groupBy ?? 'month'];
      const [inv] = await pool.query(`SELECT DATE_FORMAT(d.issue_date, '${FMT}') AS period, SUM(IF(d.kind='invoice',1,0)) AS invoices, SUM(${T('d.total_ht')}) AS ht, SUM(${T('d.total_tax')}) AS tax, SUM(${T('d.total_ttc')}) AS ttc
        FROM invoices d WHERE d.company_id = ? AND d.status = 'issued' AND d.issue_date BETWEEN ? AND ? GROUP BY period ORDER BY period`, [p.companyId, p.from, p.to]);
      const [pay] = await pool.query(`SELECT DATE_FORMAT(x.payment_date, '${FMT}') AS period, SUM(x.amount) AS collected FROM payments x JOIN companies co ON co.id = x.company_id WHERE x.company_id = ? AND x.status = 'recorded' AND x.method <> 'withholding' AND x.currency = co.currency AND x.payment_date BETWEEN ? AND ? GROUP BY period`, [p.companyId, p.from, p.to]);
      const keys = [...new Set([...inv.map((r) => r.period), ...pay.map((r) => r.period)])].sort();
      const rows = keys.map((k) => { const i = inv.find((r) => r.period === k); const c = pay.find((r) => r.period === k); return { period: k, invoices: Number(i?.invoices ?? 0), ht: fmt3(sc(i?.ht)), tax: fmt3(sc(i?.tax)), ttc: fmt3(sc(i?.ttc)), collected: fmt3(sc(c?.collected)) }; });
      return { columns: [col('period', 'Période'), col('invoices', 'Factures', 'number'), col('ht', 'CA HT (net d\'avoirs)', 'money'), col('tax', 'TVA', 'money'), col('ttc', 'CA TTC', 'money'), col('collected', 'Encaissé', 'money')], rows, totals: { ...totals(rows, ['ht', 'tax', 'ttc', 'collected']), invoices: String(rows.reduce((s, r) => s + r.invoices, 0)) }, chart: { type: 'bar', x: 'period', series: [{ key: 'ht', label: 'CA HT' }, { key: 'collected', label: 'Encaissé' }] } };
    },
  },
  by_client: {
    title: 'Rapport par client', group: 'Ventes', needs: ['invoice.read'], filters: ['period'], note: `${NOTE_FX} Solde = reste dû actuel sur les factures de la période.`,
    async run(p) {
      const [rows] = await pool.query(`SELECT c.name AS party, c.tax_id AS taxId, SUM(IF(d.kind='invoice',1,0)) AS invoices, SUM(${T('d.total_ht')}) AS ht, SUM(${T('d.total_ttc')}) AS ttc,
          SUM(IF(d.kind='invoice', ROUND(${BAL_S} * d.exchange_rate, 3), 0)) AS balance
        FROM invoices d JOIN clients c ON c.id = d.client_id WHERE d.company_id = ? AND d.status = 'issued' AND d.issue_date BETWEEN ? AND ? GROUP BY c.id, c.name, c.tax_id ORDER BY ht DESC`, [p.companyId, p.from, p.to]);
      rows.forEach((r) => { r.invoices = Number(r.invoices); r.ht = fmt3(sc(r.ht)); r.ttc = fmt3(sc(r.ttc)); r.balance = fmt3(sc(r.balance)); });
      const tot = rows.reduce((acc, r) => acc + sc(r.ht), 0n); // part du CA : affichage uniquement
      rows.forEach((r) => { r.share = tot > 0n ? `${((Number(sc(r.ht)) / Number(tot)) * 100).toFixed(1)} %` : '—'; });
      return { columns: [col('party', 'Client'), col('taxId', 'MF'), col('invoices', 'Factures', 'number'), col('ht', 'CA HT net', 'money'), col('ttc', 'CA TTC net', 'money'), col('share', 'Part du CA'), col('balance', 'Solde dû', 'money')], rows, totals: totals(rows, ['ht', 'ttc', 'balance']), chart: { type: 'bar', x: 'party', series: [{ key: 'ht', label: 'CA HT' }] } };
    },
  },
  by_product: {
    title: 'Rapport par produit', group: 'Ventes', needs: ['invoice.read'], filters: ['period'],
    note: `${NOTE_FX} Montants des lignes avant remise globale éventuelle (la remise globale n'est pas ventilée par article) : le total peut différer du CA HT.`,
    async run(p) {
      const [rows] = await pool.query(`SELECT COALESCE(pr.name, l.description) AS product, pr.sku AS sku, SUM(l.quantity * ${SGN}) AS quantity, SUM(ROUND(l.net_amount * d.exchange_rate, 3) * ${SGN}) AS ht, COUNT(DISTINCT d.id) AS docs
        FROM invoice_lines l JOIN invoices d ON d.id = l.invoice_id LEFT JOIN products pr ON pr.id = l.product_id WHERE d.company_id = ? AND d.status = 'issued' AND d.issue_date BETWEEN ? AND ?
        GROUP BY COALESCE(CAST(l.product_id AS CHAR), l.description), COALESCE(pr.name, l.description), pr.sku ORDER BY ht DESC`, [p.companyId, p.from, p.to]);
      rows.forEach((r) => { r.docs = Number(r.docs); r.ht = fmt3(sc(r.ht)); r.quantity = String(r.quantity); r.avg = Number(r.quantity) !== 0 ? fmt3(sc(r.ht) * 1000n / BigInt(Math.round(Number(r.quantity) * 1000))) : '0.000'; });
      return { columns: [col('product', 'Article / service'), col('sku', 'Réf.'), col('quantity', 'Quantité nette', 'qty'), col('docs', 'Documents', 'number'), col('ht', 'CA HT', 'money'), col('avg', 'Prix moyen HT', 'money')], rows, totals: { ht: sumCol(rows, 'ht') }, chart: { type: 'bar', x: 'product', series: [{ key: 'ht', label: 'CA HT' }] } };
    },
  },
};

function aging(key, title, group, need, table, party, pcol, where, BAL, label) {
  return {
    title, group, needs: [need], filters: ['asOf'], note: `Solde restant dû à la date choisie, ventilé par ancienneté d'échéance. ${NOTE_FX.replace(' Avoirs en négatif.', '')} Rapport de gestion non certifié.`,
    async run(p) {
      const [docs] = await pool.query(`SELECT x.id AS pid, x.name AS party, d.currency, ROUND(${BAL} * d.exchange_rate, 3) AS bal, DATEDIFF(?, d.due_date) AS late
        FROM ${table} d JOIN ${party} x ON x.id = d.${pcol} WHERE d.company_id = ? AND ${where} AND d.issue_date <= ? AND ${BAL} > 0`, [p.asOf, p.companyId, p.asOf]);
      const map = new Map();
      for (const d of docs) {
        const r = map.get(d.pid) ?? { party: d.party, docs: 0, notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90p: 0n, total: 0n };
        const b = sc(d.bal); r.docs += 1; r[bucketOf(Number(d.late))] += b; r.total += b; map.set(d.pid, r);
      }
      const rows = [...map.values()].sort((a, b) => (b.total > a.total ? 1 : -1)).map((r) => ({ party: r.party, docs: r.docs, ...Object.fromEntries(BUCKETS.map(([k]) => [k, fmt3(r[k])])), total: fmt3(r.total) }));
      cap(rows);
      return { columns: [col('party', label), col('docs', 'Factures', 'number'), ...BUCKETS.map(([k, l]) => col(k, l, 'money')), col('total', 'Total dû', 'money')], rows, totals: totals(rows, [...BUCKETS.map(([k]) => k), 'total']), key };
    },
  };
}

export const CATALOG = Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, group: r.group, filters: r.filters, needs: r.needs, note: r.note }));
