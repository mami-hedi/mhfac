// Brique commune devis / factures / avoirs : validation des entrées, résolution des références DANS l'entreprise,
// calcul serveur (core/calc.js), persistance des lignes et lecture/DTO.
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { computeDocument, toScaled } from '../../core/calc.js';
import { getSettings } from '../companies/settings.js';

export const idParam = z.object({ id: z.string().uuid() });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ').refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s); }, 'Date invalide');
const opt = (schema) => z.preprocess((v) => (v === '' || v === undefined ? null : v), schema.nullable());
const dec = (re, msg) => z.union([z.string(), z.number()]).transform((v) => String(v).trim().replace(',', '.')).refine((s) => re.test(s), msg);
const qty = dec(/^\d{1,11}(\.\d{1,4})?$/, 'Quantité positive (4 décimales max)').refine((s) => Number(s) > 0, 'Quantité > 0');
const price = dec(/^\d{1,12}(\.\d{1,3})?$/, 'Prix positif (3 décimales max)');
const pct = dec(/^\d{1,3}(\.\d{1,2})?$/, 'Pourcentage invalide').refine((s) => Number(s) <= 100, 'Maximum 100 %');
const rate6 = dec(/^\d{1,9}(\.\d{1,6})?$/, 'Taux de change invalide').refine((s) => Number(s) > 0, 'Taux > 0');

export const qtySchema = qty;
export const lineSchema = z.object({
  productId: opt(z.string().uuid()),
  description: opt(z.string().trim().min(1).max(500)),
  quantity: qty,
  unit: opt(z.string().trim().min(1).max(20)),
  unitPrice: price.optional(),
  discountPct: pct.default('0'),
  taxRateId: opt(z.string().uuid()),
  fodec: z.boolean().optional(), // case « soumis au FODEC » de la ligne ; absente = valeur de l'article
}).refine((l) => l.productId || (l.description && l.unitPrice !== undefined), { message: 'Description et prix requis pour une ligne libre', path: ['description'] });

// Les totaux envoyés par le client ne sont PAS lus : zod retire toute clé inconnue.
export const bodyBase = {
  clientId: z.string().uuid(),
  issueDate: isoDate,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  exchangeRate: rate6.optional(),
  rateDate: opt(isoDate),
  globalDiscountPct: pct.default('0'),
  applyStampDuty: z.boolean().optional(),
  // Achats uniquement : montant du timbre figurant sur la facture du FOURNISSEUR (varie selon le document). Ignoré pour les ventes (montant des paramètres).
  stampDutyAmount: z.preprocess((v) => (v === '' || v === undefined ? null : typeof v === 'number' ? String(v) : v), z.string().trim().regex(/^\d{1,4}([.,]\d{1,3})?$/, 'Timbre : montant invalide (3 décimales max)')
    .transform((v) => { const [i, f = ''] = v.replace(',', '.').split('.'); return `${Number(i)}.${f.padEnd(3, '0')}`; }).nullable()).optional(),
  withholdingPct: pct.optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  notes: opt(z.string().trim().max(3000)),
  terms: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(3000).nullable().optional()),
  lines: z.array(lineSchema).min(1, 'Au moins une ligne').max(200),
};

export const todayTunis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
export const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export async function loadCompany(conn, companyId) {
  const [[c]] = await conn.query('SELECT * FROM companies WHERE id = ?', [companyId]);
  return c;
}

export const clientSnapshot = (c) => ({ code: c.code, name: c.name, type: c.type, taxId: c.tax_id, tradeRegister: c.trade_register, address: c.address, governorate: c.governorate, postalCode: c.postal_code, phone: c.phone, email: c.email, country: c.country });
export async function companySnapshot(conn, companyId) {
  const c = await loadCompany(conn, companyId); const s = await getSettings(companyId, conn);
  return { name: c.name, legalName: c.legal_name, taxId: c.tax_id, ...s.identity };
}

// Valide l'entrée, résout client / produits / taux dans l'entreprise, calcule. Aucune écriture.
export async function prepare(conn, auth, body, { allowStamp = true, party = 'client' } = {}) {
  const buying = party === 'supplier';
  const company = await loadCompany(conn, auth.companyId);
  const settings = await getSettings(auth.companyId, conn);
  const [[client]] = await conn.query(`SELECT * FROM ${buying ? 'suppliers' : 'clients'} WHERE company_id = ? AND public_id = ?`, [auth.companyId, buying ? body.supplierId : body.clientId]);
  if (!client) throw new HttpError(422, 'UNKNOWN_REFERENCE', buying ? 'Fournisseur introuvable' : 'Client introuvable');
  if (client.status !== 'active') throw new HttpError(422, buying ? 'SUPPLIER_ARCHIVED' : 'CLIENT_ARCHIVED', buying ? 'Ce fournisseur est archivé' : 'Ce client est archivé');

  const currency = body.currency ?? client.currency ?? company.currency;
  let exchangeRate = '1.000000'; let rateDate = null;
  if (currency !== company.currency) {
    if (!body.exchangeRate) throw new HttpError(422, 'EXCHANGE_RATE_REQUIRED', `Taux de change ${currency} → ${company.currency} requis`);
    exchangeRate = Number(body.exchangeRate).toFixed(6); rateDate = body.rateDate ?? body.issueDate;
  }

  const productIds = [...new Set(body.lines.map((l) => l.productId).filter(Boolean))];
  const products = new Map();
  if (productIds.length) {
    const [rows] = await conn.query(`SELECT p.*, t.public_id AS tax_pid FROM products p LEFT JOIN tax_rates t ON t.id = p.tax_rate_id WHERE p.company_id = ? AND p.public_id IN (?)`, [auth.companyId, productIds]);
    rows.forEach((r) => products.set(r.public_id, r));
    if (products.size !== productIds.length) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Article introuvable');
  }
  const [taxes] = await conn.query('SELECT * FROM tax_rates WHERE company_id = ?', [auth.companyId]);
  const taxByPid = new Map(taxes.map((t) => [t.public_id, t]));
  const defaultTax = taxes.find((t) => t.is_default && t.is_active);

  const lines = body.lines.map((l, i) => {
    const p = l.productId ? products.get(l.productId) : null;
    const tax = l.taxRateId ? taxByPid.get(l.taxRateId) : (p?.tax_pid ? taxByPid.get(p.tax_pid) : defaultTax);
    if (!tax) throw new HttpError(422, 'UNKNOWN_REFERENCE', `Ligne ${i + 1} : taux de TVA introuvable`);
    if (!tax.is_active && l.taxRateId) throw new HttpError(422, 'INACTIVE_TAX_RATE', `Ligne ${i + 1} : taux de TVA désactivé`);
    return {
      productId: p?.id ?? null, description: l.description ?? p.name, quantity: l.quantity, unit: l.unit ?? p?.unit ?? 'unité',
      unitPrice: l.unitPrice ?? (buying ? (p.purchase_price ?? '0.000') : p.sale_price), discountPct: l.discountPct, taxRate: tax.rate, taxName: tax.name, sourceLineId: l.sourceLineId ?? null,
      // FODEC : seulement en vente, si activé ; la case de la ligne l'emporte, sinon l'article décide (jamais pour une ligne libre)
      fodec: !buying && settings.sales.fodecEnabled ? (l.fodec ?? !!p?.fodec_subject) : false,
    };
  });

  const stampOn = allowStamp && (buying ? body.applyStampDuty === true : (body.applyStampDuty ?? settings.sales.stampDutyEnabled)) && currency === company.currency;
  const stampDuty = stampOn ? (buying && body.stampDutyAmount != null ? body.stampDutyAmount : settings.sales.stampDutyAmount) : '0.000';
  const withholdingPct = body.withholdingPct ?? (buying ? '0.00' : settings.sales.defaultWithholdingPct);
  const fodecRate = !buying && settings.sales.fodecEnabled ? settings.sales.fodecRate : '0.00';
  let calc;
  try { calc = computeDocument({ lines, globalDiscountPct: body.globalDiscountPct, stampDuty, withholdingPct, fodecRate }); }
  catch (e) { throw new HttpError(422, 'INVALID_AMOUNT', e.message); }
  if (toScaled(calc.totalTtc, 3) > 999_999_999_999_999n) throw new HttpError(422, 'INVALID_AMOUNT', 'Montant trop élevé');

  return {
    client, company, settings, calc, lines, currency, exchangeRate, rateDate, stampDuty, withholdingPct, fodecRate,
    paymentTermsDays: body.paymentTermsDays ?? client.payment_terms_days ?? settings.sales.defaultPaymentTermsDays,
    terms: body.terms === undefined ? (buying ? null : (settings.sales.defaultTerms || null)) : body.terms,
  };
}

export const headerValues = (p, body, party = 'client') => ({
  [`${party}_id`]: p.client.id, [`${party}_snapshot`]: JSON.stringify(clientSnapshot(p.client)), issue_date: body.issueDate, currency: p.currency,
  exchange_rate: p.exchangeRate, rate_date: p.rateDate, global_discount_pct: body.globalDiscountPct,
  subtotal: p.calc.subtotal, line_discount_total: p.calc.lineDiscountTotal, global_discount_amount: p.calc.globalDiscountAmount,
  total_ht: p.calc.totalHt, total_tax: p.calc.totalTax, total_ttc: p.calc.totalTtc, stamp_duty: p.calc.stampDuty,
  ...(party === 'client' ? { fodec_rate: p.calc.fodecRate, fodec_amount: p.calc.fodecAmount } : {}),
  withholding_rate: p.withholdingPct, withholding_amount: p.calc.withholdingAmount, net_payable: p.calc.netPayable,
  payment_terms_days: p.paymentTermsDays, notes: body.notes ?? null, terms: p.terms,
});

// replace=true uniquement pour la mise à jour d'un brouillon : un DELETE sur un document neuf poserait des verrous d'intervalle (deadlocks en création concurrente).
export async function writeLines(conn, parent, parentId, p, { replace = false } = {}) {
  if (replace) {
    await conn.query(`DELETE FROM ${parent}_lines WHERE ${parent}_id = ?`, [parentId]);
    await conn.query(`DELETE FROM ${parent}_tax_lines WHERE ${parent}_id = ?`, [parentId]);
  }
  for (const [i, l] of p.lines.entries()) {
    const c = p.calc.lines[i];
    const cols = [`${parent}_id`, 'position', 'product_id', 'description', 'quantity', 'unit', 'unit_price', 'discount_pct', 'tax_rate', 'tax_name', 'gross_amount', 'discount_amount', 'net_amount'];
    const vals = [parentId, i + 1, l.productId, l.description, l.quantity, l.unit, l.unitPrice, l.discountPct, c.taxRate, l.taxName, c.grossAmount, c.discountAmount, c.netAmount];
    if (parent.endsWith('invoice')) { cols.push('source_line_id'); vals.push(l.sourceLineId); }
    if (['quote', 'sales_order', 'invoice'].includes(parent)) { cols.push('fodec'); vals.push(l.fodec ? 1 : 0); }
    await conn.query(`INSERT INTO ${parent}_lines (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
  }
  for (const t of p.calc.taxes) await conn.query(`INSERT INTO ${parent}_tax_lines (${parent}_id, tax_rate, base, amount) VALUES (?,?,?,?)`, [parentId, t.taxRate, t.base, t.amount]);
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const DATE = (col) => `DATE_FORMAT(d.${col}, '%Y-%m-%d') AS ${col}_s`;

export async function findDoc(conn, parent, companyId, publicId, { forUpdate = false } = {}) {
  const table = `${parent}s`;
  const extraDates = parent === 'quote' ? [DATE('valid_until')] : parent === 'sales_order' ? [DATE('expected_date')] : [DATE('due_date')];
  const [[row]] = await conn.query(
    `SELECT d.*, ${DATE('issue_date')}, ${extraDates.join(',')}, c.public_id AS client_pid FROM ${table} d JOIN clients c ON c.id = d.client_id WHERE d.company_id = ? AND d.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`,
    [companyId, publicId]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Document introuvable');
  return row;
}

export async function loadLines(conn, parent, id) {
  const [lines] = await conn.query(`SELECT l.*, p.public_id AS product_pid FROM ${parent}_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.${parent}_id = ? ORDER BY l.position`, [id]);
  const [taxes] = await conn.query(`SELECT tax_rate, base, amount FROM ${parent}_tax_lines WHERE ${parent}_id = ? ORDER BY tax_rate`, [id]);
  return { lines, taxes };
}

export const lineDto = (l) => ({ id: l.id, position: l.position, productId: l.product_pid ?? null, description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unit_price, discountPct: l.discount_pct, taxRate: l.tax_rate, taxName: l.tax_name, grossAmount: l.gross_amount, discountAmount: l.discount_amount, netAmount: l.net_amount, fodec: !!l.fodec });

export const amountsDto = (r) => ({ subtotal: r.subtotal, lineDiscountTotal: r.line_discount_total, globalDiscountAmount: r.global_discount_amount, totalHt: r.total_ht, totalTax: r.total_tax, totalTtc: r.total_ttc, fodecRate: r.fodec_rate ?? '0.00', fodecAmount: r.fodec_amount ?? '0.000', stampDuty: r.stamp_duty, withholdingRate: r.withholding_rate, withholdingAmount: r.withholding_amount, netPayable: r.net_payable });

export const commonDto = (r) => ({
  clientId: r.client_pid, client: parse(r.client_snapshot), company: r.company_snapshot ? parse(r.company_snapshot) : null,
  issueDate: r.issue_date_s, currency: r.currency, exchangeRate: r.exchange_rate, rateDate: r.rate_date ? String(r.rate_date).slice(0, 10) : null,
  globalDiscountPct: r.global_discount_pct, paymentTermsDays: r.payment_terms_days, notes: r.notes, terms: r.terms, ...amountsDto(r), createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function history(companyId, entityType, publicId) {
  const [rows] = await pool.query(
    `SELECT a.action, a.meta, a.created_at, u.full_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE a.company_id = ? AND a.entity_type = ? AND a.entity_id = ? ORDER BY a.id DESC LIMIT 200`,
    [companyId, entityType, publicId]);
  return rows.map((r) => ({ action: r.action, by: r.full_name, at: r.created_at, meta: r.meta ? parse(r.meta) : null }));
}
