// Retenue à la source : listes dérivées des factures (le montant vient TOUJOURS de la facture) + suivi des attestations.
// Ventes   : retenue subie sur nos factures émises -> attestation à recevoir du client.
// Achats   : retenue opérée sur une facture d'achat enregistrée -> attestation à délivrer au fournisseur.
// Retenue AJOUTÉE après l'émission (document_withholdings, créée via POST /payments/withholding ou /supplier-payments/withholding) : la facture reste à 0 de retenue,
// la retenue active (règlement 'withholding' non annulé) est ajoutée à la lecture. Annulée => elle disparaît de ces listes.
// Seul le suivi d'attestation (statut, n°, date) est modifiable ici ; la facture n'est jamais touchée.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { listQuerySchema, escapeLike } from '../../core/list.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { toCsv } from '../../core/csv.js';
import { sendCsv, csvDate } from '../../core/list-filters.js';
import { checkRow, toPrepRow, duplicateRefs, tejOperation } from './tej-prep.js';
import { OPERATION_CODES, isCode } from './tej-codes.js';
import { buildTejXml, loadXsd, validateAgainstXsd, fileName, isMf, cleanText } from './tej-xml.js';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const CFG = {
  sales: { direction: 'sales', table: 'invoices', payTable: 'payments', party: 'clients', partyCol: 'client_id', where: "d.kind = 'invoice' AND d.status = 'issued'", date: 'd.issue_date', numberCol: 'd.number', refCol: 'NULL' },
  purchases: { direction: 'purchase', table: 'purchase_invoices', payTable: 'supplier_payments', party: 'suppliers', partyCol: 'supplier_id', where: "d.kind = 'invoice' AND d.status = 'recorded'", date: 'd.issue_date', numberCol: 'd.number', refCol: 'd.supplier_ref' },
};
const router = Router();
router.use(authenticate);
const activeRs = (dir, payTable) => `(SELECT x.company_id, x.invoice_id, x.payment_id, x.rate, x.amount, x.withholding_date, x.certificate_number FROM document_withholdings x JOIN ${payTable} pm ON pm.id = x.payment_id AND pm.status = 'recorded' WHERE x.direction = '${dir}')`;
const hasRs = (dir, payTable) => `EXISTS (SELECT 1 FROM document_withholdings x JOIN ${payTable} pm ON pm.id = x.payment_id AND pm.status = 'recorded' WHERE x.company_id = d.company_id AND x.direction = '${dir}' AND x.invoice_id = d.id)`;
const WA = '(d.withholding_amount + COALESCE(dw.amount, 0))'; const WR = '(d.withholding_rate + COALESCE(dw.rate, 0))';
const TND = `ROUND(${WA} * d.exchange_rate, 3)`;

for (const [path, C] of Object.entries(CFG)) {
  const base = (extraWhere = '') => `FROM ${C.table} d JOIN ${C.party} p ON p.id = d.${C.partyCol}
    LEFT JOIN ${activeRs(C.direction, C.payTable)} dw ON dw.company_id = d.company_id AND dw.invoice_id = d.id
    LEFT JOIN withholding_certificates w ON w.company_id = d.company_id AND w.direction = '${C.direction}' AND w.invoice_id = d.id
    WHERE d.company_id = ? AND ${C.where} AND ${WA} > 0 ${extraWhere}`;

  router.get(`/${path}`, requirePermission('withholding.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({
    status: z.enum(['pending', 'done']).optional(), from: iso.optional(), to: iso.optional(), partyId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
    const q = req.query; const where = []; const params = [req.auth.companyId];
    if (q.status === 'done') where.push("w.status = 'done'"); if (q.status === 'pending') where.push("(w.status IS NULL OR w.status = 'pending')");
    if (q.from) { where.push(`${C.date} >= ?`); params.push(q.from); } if (q.to) { where.push(`${C.date} <= ?`); params.push(q.to); }
    if (q.partyId) { where.push('p.public_id = ?'); params.push(q.partyId); }
    if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push(`(d.number LIKE ? OR p.name LIKE ? OR COALESCE(w.certificate_number, dw.certificate_number) LIKE ?${path === 'purchases' ? ' OR d.supplier_ref LIKE ?' : ''})`); params.push(like, like, like); if (path === 'purchases') params.push(like); }
    const w = where.length ? ` AND ${where.join(' AND ')}` : '';
    const [[agg]] = await pool.query(`SELECT COUNT(*) AS total, COALESCE(SUM(${TND}),0) AS t_all, COALESCE(SUM(CASE WHEN w.status = 'done' THEN ${TND} END),0) AS t_done ${base(w)}`, params);
    const [rows] = await pool.query(`SELECT d.public_id, ${C.numberCol} AS number, ${C.refCol} AS supplier_ref, DATE_FORMAT(${C.date},'%Y-%m-%d') AS d_s, d.currency, d.exchange_rate, d.total_ttc, ${WR} AS withholding_rate, ${WA} AS withholding_amount, dw.amount IS NOT NULL AS added, dw.withholding_date AS added_date, ${TND} AS amount_tnd,
        p.public_id AS party_pid, p.name AS party_name, p.tax_id AS party_tax_id, COALESCE(w.status,'pending') AS cert_status, COALESCE(w.certificate_number, dw.certificate_number) AS certificate_number, DATE_FORMAT(w.certificate_date,'%Y-%m-%d') AS cert_date, w.notes AS cert_notes
      ${base(w)} ORDER BY ${C.date} DESC, d.id DESC LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
    res.json({ data: rows.map((r) => ({ invoiceId: r.public_id, number: r.number, supplierRef: r.supplier_ref, date: r.d_s, party: { id: r.party_pid, name: r.party_name, taxId: r.party_tax_id }, currency: r.currency,
      totalTtc: r.total_ttc, rate: r.withholding_rate, amount: r.withholding_amount, amountTnd: r.amount_tnd, added: !!r.added, certificate: { status: r.cert_status, number: r.certificate_number, date: r.cert_date, notes: r.cert_notes } })),
    meta: { page: q.page, limit: q.limit, total: agg.total, pages: Math.max(1, Math.ceil(agg.total / q.limit)), totalTnd: agg.t_all, certifiedTnd: agg.t_done } });
  }));

  router.put(`/${path}/:id/certificate`, requirePermission('withholding.write'), validate({ params: z.object({ id: z.string().uuid() }), body: z.object({
    status: z.enum(['pending', 'done']), certificateNumber: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(60).nullable().optional()),
    certificateDate: z.preprocess((v) => (v === '' ? null : v), iso.nullable().optional()), notes: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(500).nullable().optional()) }) }), asyncHandler(async (req, res) => {
    const b = req.body;
    const [[inv]] = await pool.query(`SELECT d.id FROM ${C.table} d WHERE d.company_id = ? AND d.public_id = ? AND ${C.where} AND (d.withholding_amount > 0 OR ${hasRs(C.direction, C.payTable)})`, [req.auth.companyId, req.params.id]);
    if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Facture avec retenue introuvable');
    if (b.status === 'done' && (!b.certificateNumber || !b.certificateDate)) throw new HttpError(422, 'CERTIFICATE_INCOMPLETE', "Numéro et date de l'attestation requis pour la marquer reçue/délivrée");
    await pool.query(`INSERT INTO withholding_certificates (company_id, direction, invoice_id, status, certificate_number, certificate_date, notes, updated_by) VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE status = VALUES(status), certificate_number = VALUES(certificate_number), certificate_date = VALUES(certificate_date), notes = VALUES(notes), updated_by = VALUES(updated_by)`,
    [req.auth.companyId, C.direction, inv.id, b.status, b.status === 'done' ? b.certificateNumber : (b.certificateNumber ?? null), b.status === 'done' ? b.certificateDate : (b.certificateDate ?? null), b.notes ?? null, req.auth.userId]);
    await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'withholding_certificate.update', entityType: C.table, entityId: req.params.id, ip: req.ip, meta: { direction: C.direction, status: b.status, number: b.certificateNumber ?? null } });
    res.json({ data: { invoiceId: req.params.id, status: b.status, number: b.certificateNumber ?? null, date: b.certificateDate ?? null, notes: b.notes ?? null } });
  }));
}

// ---- Préparation TEJ (retenues opérées sur nos achats, par mois de paiement) — contrôle + CSV, PAS le XML officiel ----
const monthQ = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mois AAAA-MM') });
async function tejRows(companyId, month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`; const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const [rows] = await pool.query(`SELECT d.public_id, d.number, d.supplier_ref, d.currency, d.net_payable, DATE_FORMAT(d.issue_date,'%Y-%m-%d') AS issue_date, d.total_ht, d.total_tax, d.total_ttc, d.stamp_duty, (d.withholding_rate + COALESCE(MAX(dw.rate), 0)) AS withholding_rate, (d.withholding_amount + COALESCE(MAX(dw.amount), 0)) AS withholding_amount, p.name AS supplier_name, p.tax_id, p.type AS supplier_type, p.address AS supplier_address, p.email AS supplier_email, p.phone AS supplier_phone, p.country AS supplier_country,
      o.operation_code, o.cnpc, o.p_charge, COALESCE(wc.certificate_number, MAX(dw.certificate_number)) AS certificate_number, (SELECT COALESCE(SUM(a2.amount),0) FROM supplier_payment_allocations a2 JOIN supplier_payments sp2 ON sp2.id = a2.payment_id AND sp2.status = 'recorded' WHERE a2.invoice_id = d.id) AS paid_total,
      DATE_FORMAT(MAX(sp.payment_date),'%Y-%m-%d') AS payment_date
    FROM purchase_invoices d JOIN suppliers p ON p.id = d.supplier_id
    LEFT JOIN ${activeRs('purchase', 'supplier_payments')} dw ON dw.company_id = d.company_id AND dw.invoice_id = d.id
    JOIN supplier_payment_allocations a ON a.invoice_id = d.id
    JOIN supplier_payments sp ON sp.id = a.payment_id AND sp.status = 'recorded' AND sp.payment_date >= ? AND sp.payment_date < ? AND (dw.payment_id IS NULL OR sp.id = dw.payment_id)
    LEFT JOIN withholding_tej_operations o ON o.company_id = d.company_id AND o.invoice_id = d.id
    LEFT JOIN withholding_certificates wc ON wc.company_id = d.company_id AND wc.direction = 'purchase' AND wc.invoice_id = d.id
    WHERE d.company_id = ? AND d.kind = 'invoice' AND d.status = 'recorded' AND (d.withholding_amount > 0 OR dw.amount IS NOT NULL)
    GROUP BY d.id ORDER BY MAX(sp.payment_date), d.id`, [start, end, companyId]);
  const mapped = rows.map((r) => ({ id: r.public_id, number: r.number, supplierRef: r.supplier_ref, supplierName: r.supplier_name, taxId: r.tax_id, totalHt: r.total_ht, totalTax: r.total_tax, totalTtc: r.total_ttc, stampDuty: r.stamp_duty, rate: r.withholding_rate, amount: r.withholding_amount, paymentDate: r.payment_date, currency: r.currency, netPayable: r.net_payable, paidTotal: r.paid_total, issueDate: r.issue_date, operationCode: r.operation_code, cnpc: r.cnpc, pCharge: r.p_charge, certificateNumber: r.certificate_number, supplierType: r.supplier_type, supplierAddress: r.supplier_address, supplierEmail: r.supplier_email, supplierPhone: r.supplier_phone, supplierCountry: r.supplier_country }));
  const prep = mapped.map((r) => ({ ...toPrepRow(r), reference: r.certificateNumber || r.number })); const dup = duplicateRefs(prep);
  return mapped.map((r, i) => { const t = tejOperation(r); const issues = [...checkRow(r).filter((x) => !x.code.startsWith('TAXID')), ...t.issues]; if (dup.has(String(prep[i].reference))) issues.push({ code: 'REF_DUPLICATE', level: 'error', message: 'Référence de certificat en double dans ce dépôt' }); return { source: r, prep: prep[i], op: t.op, issues }; });
}
router.get('/purchases/tej-prep', requirePermission('withholding.read'), validate({ query: monthQ }), asyncHandler(async (req, res) => {
  const items = await tejRows(req.auth.companyId, req.query.month);
  const errors = items.filter((i) => i.issues.some((x) => x.level === 'error')).length;
  res.json({ data: items.map((i) => ({ invoiceId: i.source.id, ...i.prep, operationCode: i.source.operationCode ?? null, cnpc: !!i.source.cnpc, pCharge: !!i.source.pCharge, issues: i.issues })), meta: { month: req.query.month, total: items.length, withErrors: errors, ready: items.length - errors,
    notice: "Préparation uniquement : ce n'est pas le fichier XML officiel TEJ ni une déclaration. Vérifiez avec votre comptable avant tout dépôt sur la plateforme TEJ." } });
}));
router.get('/purchases/tej-prep/export', requirePermission('withholding.read'), validate({ query: monthQ }), asyncHandler(async (req, res) => {
  const items = await tejRows(req.auth.companyId, req.query.month);
  const head = ['Référence certificat', 'Facture', 'Matricule fiscal', 'Fournisseur', 'Date de paiement', 'Montant HT (millimes)', 'TVA (millimes)', 'TTC (millimes)', 'Taux retenue %', 'Retenue (millimes)', 'Net servi (millimes)', 'Contrôle'];
  const text = toCsv(head, items.map(({ prep: p, issues }) => [p.reference, p.invoice, p.taxId, p.supplier, csvDate(p.paymentDate), p.ht, p.tva, p.ttc, p.rate.replace('.', ','), p.retenue, p.net, issues.length ? issues.map((x) => x.message).join(' | ') : 'OK']));
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'withholding.tej_prep_export', entityType: 'purchase_invoices', entityId: null, ip: req.ip, meta: { month: req.query.month, rows: items.length } });
  sendCsv(res, `preparation-tej-${req.query.month}.csv`, text, { total: items.length, shown: items.length });
}));

router.get('/tej/codes', requirePermission('withholding.read'), (req, res) => res.json({ data: Object.values(OPERATION_CODES) }));

router.put('/purchases/:id/tej-operation', requirePermission('withholding.write'), validate({ params: z.object({ id: z.string().uuid() }), body: z.object({
  operationCode: z.string().refine(isCode, 'Code d\'opération TEJ inconnu'), cnpc: z.boolean().default(false), pCharge: z.boolean().default(false) }) }), asyncHandler(async (req, res) => {
  const [[inv]] = await pool.query("SELECT d.id, (d.withholding_rate + COALESCE((SELECT x.rate FROM document_withholdings x JOIN supplier_payments pm ON pm.id = x.payment_id AND pm.status = 'recorded' WHERE x.company_id = d.company_id AND x.direction = 'purchase' AND x.invoice_id = d.id LIMIT 1), 0)) AS withholding_rate FROM purchase_invoices d WHERE d.company_id = ? AND d.public_id = ? AND d.kind = 'invoice' AND d.status = 'recorded' AND (d.withholding_amount > 0 OR EXISTS (SELECT 1 FROM document_withholdings x JOIN supplier_payments pm ON pm.id = x.payment_id AND pm.status = 'recorded' WHERE x.company_id = d.company_id AND x.direction = 'purchase' AND x.invoice_id = d.id))", [req.auth.companyId, req.params.id]);
  if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Facture avec retenue introuvable');
  const b = req.body;
  await pool.query(`INSERT INTO withholding_tej_operations (company_id, invoice_id, operation_code, cnpc, p_charge, updated_by) VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE operation_code = VALUES(operation_code), cnpc = VALUES(cnpc), p_charge = VALUES(p_charge), updated_by = VALUES(updated_by)`, [req.auth.companyId, inv.id, b.operationCode, b.cnpc ? 1 : 0, b.pCharge ? 1 : 0, req.auth.userId]);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'withholding.tej_operation', entityType: 'purchase_invoices', entityId: req.params.id, ip: req.ip, meta: { code: b.operationCode, cnpc: b.cnpc, pCharge: b.pCharge } });
  res.json({ data: { invoiceId: req.params.id, operationCode: b.operationCode, cnpc: b.cnpc, pCharge: b.pCharge, rateMatches: Number(inv.withholding_rate) === Number(OPERATION_CODES[b.operationCode].rate) } });
}));

// Export XML TEJ : refusé tant que les XSD officiels ne sont pas installés ET que le fichier n'est pas valide contre eux.
router.get('/purchases/tej-prep/xml', requirePermission('withholding.read'), validate({ query: monthQ }), asyncHandler(async (req, res) => {
  const xsd = loadXsd();
  if (!xsd) throw new HttpError(409, 'TEJ_XSD_MISSING', "Schémas XSD officiels TEJ non installés (dossier server/schemas/tej) : l'export XML est désactivé tant que le fichier ne peut pas être validé");
  const [[co]] = await pool.query('SELECT tax_id, legal_name, name FROM companies WHERE id = ?', [req.auth.companyId]);
  if (!co?.tax_id || !isMf(co.tax_id)) throw new HttpError(422, 'DECLARANT_TAXID', "Matricule fiscal de votre entreprise manquant ou invalide (Paramètres)");
  const items = await tejRows(req.auth.companyId, req.query.month);
  if (!items.length) throw new HttpError(422, 'NOTHING_TO_EXPORT', 'Aucune retenue payée sur ce mois');
  const bad = items.filter((i) => i.issues.some((x) => x.level === 'error'));
  if (bad.length) throw new HttpError(422, 'TEJ_PREP_ERRORS', `${bad.length} facture(s) à corriger avant l'export XML`, { invoices: bad.map((i) => ({ number: i.source.number, issues: i.issues })) });
  const [year, month] = req.query.month.split('-');
  const certs = items.map((i) => ({ ref: i.prep.reference, paymentDate: i.source.paymentDate, beneficiary: { taxId: i.source.taxId, category: i.source.supplierType === 'individual' ? 'PP' : 'PM', resident: i.source.supplierCountry === 'TN' ? 1 : 0, name: i.source.supplierName, address: i.source.supplierAddress, email: i.source.supplierEmail, phone: i.source.supplierPhone }, operation: i.op }));
  const xml = buildTejXml({ declarant: { taxId: co.tax_id, category: 'PM' }, year, month, acte: 0, certs });
  const name = fileName(co.tax_id, year, month, 0);
  const v = await validateAgainstXsd(xml, xsd, name);
  if (!v.valid) throw new HttpError(422, 'TEJ_XSD_INVALID', 'Le fichier généré ne respecte pas le schéma XSD : export bloqué', { errors: v.errors });
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'withholding.tej_xml_export', entityType: 'purchase_invoices', entityId: null, ip: req.ip, meta: { month: req.query.month, certificates: certs.length, xsd: xsd.version } });
  res.setHeader('Content-Type', 'application/xml; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(xml);
}));

export default router;
