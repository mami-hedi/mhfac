import { newPublicId } from '../../core/ids.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { addDays, headerValues, prepare, todayTunis, writeLines } from './common.js';

// Création d'une facture BROUILLON à partir d'un corps validé comme une facture saisie à la main (prepare = même moteur de calcul).
// extra : colonnes de liaison (order_id, delivery_note_id, recurring_id, invoice_type, deposit_pct...).
export async function insertInvoiceDraft(conn, auth, body, extra = {}, { ip, meta = {} } = {}) {
  const p = await prepare(conn, auth, body);
  const due = body.dueDate ?? addDays(body.issueDate, p.paymentTermsDays);
  if (due < body.issueDate) throw new HttpError(422, 'INVALID_DATE', "L'échéance précède la date de facture");
  const publicId = newPublicId();
  const h = { ...headerValues(p, body), public_id: publicId, company_id: auth.companyId, kind: 'invoice', status: 'draft', due_date: due, created_by: auth.userId, ...extra };
  const [r] = await conn.query(`INSERT INTO invoices (${Object.keys(h).join(',')}) VALUES (${Object.keys(h).map(() => '?').join(',')})`, Object.values(h));
  await writeLines(conn, 'invoice', r.insertId, p);
  await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'invoice.create', entityType: 'invoices', entityId: publicId, ip, meta: { totalTtc: p.calc.totalTtc, ...meta } });
  return { publicId, id: r.insertId, p };
}

// Conversion devis -> facture brouillon : copie EXACTE des montants et lignes (aucune ressaisie, aucun recalcul divergent).
export async function createInvoiceDraft(conn, auth, { quote }, ip) {
  const publicId = newPublicId();
  const today = todayTunis();
  const due = addDays(today, quote.payment_terms_days);
  const [r] = await conn.query(
    `INSERT INTO invoices (public_id, company_id, kind, status, client_id, client_snapshot, issue_date, due_date, currency, exchange_rate, rate_date,
       global_discount_pct, subtotal, line_discount_total, global_discount_amount, total_ht, total_tax, total_ttc, stamp_duty, withholding_rate, withholding_amount, net_payable,
       payment_terms_days, notes, terms, quote_id, created_by, fodec_rate, fodec_amount)
     VALUES (?,?, 'invoice', 'draft', ?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?)`,
    [publicId, auth.companyId, quote.client_id, typeof quote.client_snapshot === 'string' ? quote.client_snapshot : JSON.stringify(quote.client_snapshot), today, due, quote.currency, quote.exchange_rate, quote.rate_date,
      quote.global_discount_pct, quote.subtotal, quote.line_discount_total, quote.global_discount_amount, quote.total_ht, quote.total_tax, quote.total_ttc, quote.stamp_duty, quote.withholding_rate, quote.withholding_amount, quote.net_payable,
      quote.payment_terms_days, quote.notes, quote.terms, quote.id, auth.userId, quote.fodec_rate, quote.fodec_amount]);
  await conn.query(
    `INSERT INTO invoice_lines (invoice_id, position, product_id, description, quantity, unit, unit_price, discount_pct, tax_rate, tax_name, gross_amount, discount_amount, net_amount, fodec)
     SELECT ?, position, product_id, description, quantity, unit, unit_price, discount_pct, tax_rate, tax_name, gross_amount, discount_amount, net_amount, fodec FROM quote_lines WHERE quote_id = ?`, [r.insertId, quote.id]);
  await conn.query('INSERT INTO invoice_tax_lines (invoice_id, tax_rate, base, amount) SELECT ?, tax_rate, base, amount FROM quote_tax_lines WHERE quote_id = ?', [r.insertId, quote.id]);
  await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'invoice.create', entityType: 'invoices', entityId: publicId, ip, meta: { fromQuote: quote.number, totalTtc: quote.total_ttc } });
  return publicId;
}
