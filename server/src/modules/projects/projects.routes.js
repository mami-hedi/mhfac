// Projets : regroupement de documents (devis, commandes, factures, avoirs, achats, notes de débours) et synthèse financière.
// Le rattachement est une métadonnée : il ne modifie jamais un montant ni le statut d'un document (même émis).
// Synthèse en devise de l'entreprise (montant HT × taux du document) ; seuls les documents émis / enregistrés / validés comptent.
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { nextNumber, formatCode } from '../../core/numbering.js';
import { listQuerySchema, escapeLike } from '../../core/list.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { idParam } from '../sales/common.js';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const opt = (s) => z.preprocess((v) => (v === '' ? null : v), s.nullable().optional());
const money = z.union([z.string(), z.number()]).transform((v) => String(v).trim().replace(',', '.')).refine((s) => /^\d{1,12}(\.\d{1,3})?$/.test(s), 'Montant positif (3 décimales max)');
// docType → description des tables ; "counts" = condition pour entrer dans la synthèse ; side : sales | purchase
const DOCS = {
  quote: { table: 'quotes', label: 'Devis', party: 'clients', pcol: 'client_id', num: 'd.number', date: 'd.issue_date', ht: 'd.total_ht', fx: 'd.exchange_rate', side: 'sales', path: '/sales/quotes' },
  sales_order: { table: 'sales_orders', label: 'Commande client', party: 'clients', pcol: 'client_id', num: 'd.number', date: 'd.issue_date', ht: 'd.total_ht', fx: 'd.exchange_rate', side: 'sales', path: '/sales/orders' },
  invoice: { table: 'invoices', label: 'Facture', party: 'clients', pcol: 'client_id', num: 'd.number', date: 'd.issue_date', ht: 'd.total_ht', fx: 'd.exchange_rate', side: 'sales', kind: 'invoice', counts: "d.status = 'issued'", sign: 1, bucket: 'invoiced', path: '/sales/invoices' },
  credit_note: { table: 'invoices', label: 'Avoir', party: 'clients', pcol: 'client_id', num: 'd.number', date: 'd.issue_date', ht: 'd.total_ht', fx: 'd.exchange_rate', side: 'sales', kind: 'credit_note', counts: "d.status = 'issued'", sign: -1, bucket: 'invoiced', path: '/sales/credit-notes' },
  purchase_order: { table: 'purchase_orders', label: 'Commande fournisseur', party: 'suppliers', pcol: 'supplier_id', num: 'd.number', date: 'd.issue_date', ht: 'd.total_ht', fx: 'd.exchange_rate', side: 'purchase', path: '/purchases/orders' },
  purchase_invoice: { table: 'purchase_invoices', label: "Facture d'achat", party: 'suppliers', pcol: 'supplier_id', num: 'd.number', date: 'd.issue_date', ht: 'd.total_ht', fx: 'd.exchange_rate', side: 'purchase', kind: 'invoice', counts: "d.status = 'recorded'", sign: 1, bucket: 'purchased', path: '/purchases/invoices' },
  purchase_credit_note: { table: 'purchase_invoices', label: 'Avoir fournisseur', party: 'suppliers', pcol: 'supplier_id', num: 'd.number', date: 'd.issue_date', ht: 'd.total_ht', fx: 'd.exchange_rate', side: 'purchase', kind: 'credit_note', counts: "d.status = 'recorded'", sign: -1, bucket: 'purchased', path: '/purchases/credit-notes' },
  expense_note_sales: { table: 'expense_notes', label: 'Note de débours (vente)', party: 'clients', pcol: 'client_id', num: 'd.number', date: 'd.note_date', ht: 'd.total', fx: '1', side: 'sales', kind: 'sales', counts: "d.status = 'validated'", sign: 1, bucket: 'expenseSales', path: '/sales/expense-notes' },
  expense_note_purchase: { table: 'expense_notes', label: 'Note de débours (achat)', party: 'suppliers', pcol: 'supplier_id', num: 'd.number', date: 'd.note_date', ht: 'd.total', fx: '1', side: 'purchase', kind: 'purchase', counts: "d.status = 'validated'", sign: 1, bucket: 'expensePurchase', path: '/purchases/expense-notes' },
};
const kindWhere = (D) => (D.kind ? ` AND d.${D.table === 'expense_notes' ? 'kind' : 'kind'} = '${D.kind}'` : '');
const docType = z.enum(Object.keys(DOCS));
const projectBody = z.object({ name: z.string().trim().min(2, 'Nom requis').max(160), clientId: opt(z.string().uuid()), status: z.enum(['active', 'on_hold', 'completed', 'cancelled']).optional(),
  startDate: opt(iso), endDate: opt(iso), budget: opt(money), description: opt(z.string().trim().max(5000)), code: opt(z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{1,39}$/, 'Code : lettres, chiffres, . _ -')) })
  .refine((b) => !b.startDate || !b.endDate || b.endDate >= b.startDate, { message: 'La date de fin précède la date de début', path: ['endDate'] });

const router = Router(); router.use(authenticate);
const SEL = `SELECT p.*, DATE_FORMAT(p.start_date,'%Y-%m-%d') AS sd, DATE_FORMAT(p.end_date,'%Y-%m-%d') AS ed, c.public_id AS client_pid, c.name AS client_name FROM projects p LEFT JOIN clients c ON c.id = p.client_id`;
const dto = (p) => ({ id: p.public_id, code: p.code, name: p.name, status: p.status, startDate: p.sd, endDate: p.ed, budget: p.budget, description: p.description, client: p.client_pid ? { id: p.client_pid, name: p.client_name } : null, createdAt: p.created_at });
async function find(conn, companyId, publicId, forUpdate = false) {
  const [[p]] = await conn.query(forUpdate ? 'SELECT * FROM projects WHERE company_id = ? AND public_id = ? FOR UPDATE' : `${SEL} WHERE p.company_id = ? AND p.public_id = ?`, [companyId, publicId]);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Projet introuvable');
  return p;
}
async function resolveClient(conn, companyId, publicId) {
  if (!publicId) return null;
  const [[c]] = await conn.query('SELECT id FROM clients WHERE company_id = ? AND public_id = ?', [companyId, publicId]);
  if (!c) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Client introuvable'); return c.id;
}

const sc = (v) => { const raw = String(v ?? '0').trim(); const neg = raw.startsWith('-'); const [i, f = ''] = raw.replace('-', '').split('.'); const n = BigInt(i + f.padEnd(3, '0').slice(0, 3)); return neg ? -n : n; };
const fmt3 = (n) => { const neg = n < 0n; const t = (neg ? -n : n).toString().padStart(4, '0'); return `${neg ? '-' : ''}${t.slice(0, -3)}.${t.slice(-3)}`; };

async function summary(companyId, projectId, budget) {
  const acc = { invoiced: 0n, purchased: 0n, expenseSales: 0n, expensePurchase: 0n };
  for (const D of Object.values(DOCS)) {
    if (!D.bucket) continue;
    const [[r]] = await pool.query(`SELECT COALESCE(SUM(ROUND(${D.ht} * ${D.fx}, 3)),0) AS t FROM ${D.table} d WHERE d.company_id = ? AND d.project_id = ? AND ${D.counts}${kindWhere(D)}`, [companyId, projectId]);
    acc[D.bucket] += BigInt(D.sign) * sc(r.t);
  }
  const costs = acc.purchased + acc.expensePurchase; const revenue = acc.invoiced + acc.expenseSales;
  const b = budget === null || budget === undefined ? null : sc(budget);
  return { invoiced: fmt3(acc.invoiced), purchased: fmt3(acc.purchased), expenseSales: fmt3(acc.expenseSales), expensePurchase: fmt3(acc.expensePurchase),
    revenue: fmt3(revenue), costs: fmt3(costs), margin: fmt3(acc.invoiced - acc.purchased), result: fmt3(revenue - costs),
    budget: budget ?? null, budgetRemaining: b === null ? null : fmt3(b - costs), budgetUsedPct: b && b > 0n ? Number((costs * 1000n) / b) / 10 : null,
    note: "Montants HT en devise de l'entreprise (HT × taux du document). Marge = facturé − achats ; résultat = facturé + débours refacturés − achats − débours payés." };
}

router.get('/', requirePermission('project.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ status: z.enum(['active', 'on_hold', 'completed', 'cancelled']).optional(), clientId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query; const where = ['p.company_id = ?']; const params = [req.auth.companyId];
  if (q.status) { where.push('p.status = ?'); params.push(q.status); } if (q.clientId) { where.push('c.public_id = ?'); params.push(q.clientId); }
  if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push('(p.code LIKE ? OR p.name LIKE ? OR c.name LIKE ?)'); params.push(like, like, like); }
  const [[agg]] = await pool.query(`SELECT COUNT(*) AS total FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE ${where.join(' AND ')}`, params);
  const [rows] = await pool.query(`${SEL} WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...params, q.limit, (q.page - 1) * q.limit]);
  res.json({ data: rows.map(dto), meta: { page: q.page, limit: q.limit, total: agg.total, pages: Math.max(1, Math.ceil(agg.total / q.limit)) } });
}));

router.post('/', requirePermission('project.write'), validate({ body: projectBody }), asyncHandler(async (req, res) => {
  const b = req.body; const publicId = newPublicId();
  await withTransaction(async (conn) => {
    const clientId = await resolveClient(conn, req.auth.companyId, b.clientId);
    const code = b.code ?? formatCode(`PRJ-${new Date().getFullYear()}`, await nextNumber(conn, req.auth.companyId, 'project', String(new Date().getFullYear())), 3);
    const [[dup]] = await conn.query('SELECT 1 AS x FROM projects WHERE company_id = ? AND code = ?', [req.auth.companyId, code]);
    if (dup) throw new HttpError(409, 'DUPLICATE_CODE', `Le code projet ${code} existe déjà`);
    await conn.query('INSERT INTO projects (public_id, company_id, code, name, client_id, status, start_date, end_date, budget, description, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [publicId, req.auth.companyId, code, b.name, clientId, b.status ?? 'active', b.startDate ?? null, b.endDate ?? null, b.budget ?? null, b.description ?? null, req.auth.userId]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'project.create', entityType: 'projects', entityId: publicId, ip: req.ip, meta: { code, name: b.name } });
  });
  res.status(201).json({ data: dto(await find(pool, req.auth.companyId, publicId)) });
}));

router.get('/:id', requirePermission('project.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const p = await find(pool, req.auth.companyId, req.params.id);
  const documents = [];
  for (const [type, D] of Object.entries(DOCS)) {
    const [rows] = await pool.query(`SELECT d.public_id, ${D.num} AS number, d.status, DATE_FORMAT(${D.date},'%Y-%m-%d') AS dt, ${D.ht} AS ht, ${D.table === 'expense_notes' ? "'TND'" : 'd.currency'} AS currency, x.name AS party_name FROM ${D.table} d JOIN ${D.party} x ON x.id = d.${D.pcol} WHERE d.company_id = ? AND d.project_id = ?${kindWhere(D)} ORDER BY ${D.date} DESC`, [req.auth.companyId, p.id]);
    for (const r of rows) documents.push({ docType: type, label: D.label, id: r.public_id, number: r.number, status: r.status, date: r.dt, totalHt: r.ht, currency: r.currency, partyName: r.party_name, path: `${D.path}/${r.public_id}` });
  }
  documents.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  res.json({ data: { ...dto(p), summary: await summary(req.auth.companyId, p.id, p.budget), documents } });
}));

router.put('/:id', requirePermission('project.write'), validate({ params: idParam, body: projectBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  await withTransaction(async (conn) => {
    const p = await find(conn, req.auth.companyId, req.params.id, true); const clientId = await resolveClient(conn, req.auth.companyId, b.clientId);
    let code = p.code;
    if (b.code && b.code !== p.code) { const [[dup]] = await conn.query('SELECT 1 AS x FROM projects WHERE company_id = ? AND code = ? AND id <> ?', [req.auth.companyId, b.code, p.id]); if (dup) throw new HttpError(409, 'DUPLICATE_CODE', `Le code projet ${b.code} existe déjà`); code = b.code; }
    await conn.query('UPDATE projects SET code = ?, name = ?, client_id = ?, status = ?, start_date = ?, end_date = ?, budget = ?, description = ? WHERE id = ?', [code, b.name, clientId, b.status ?? p.status, b.startDate ?? null, b.endDate ?? null, b.budget ?? null, b.description ?? null, p.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'project.update', entityType: 'projects', entityId: req.params.id, ip: req.ip, meta: { status: b.status ?? p.status } });
  });
  res.json({ data: dto(await find(pool, req.auth.companyId, req.params.id)) });
}));

router.delete('/:id', requirePermission('project.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const p = await find(conn, req.auth.companyId, req.params.id, true);
    for (const D of Object.values(DOCS)) { const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM ${D.table} d WHERE d.project_id = ?${kindWhere(D)}`, [p.id]); if (r.n) throw new HttpError(409, 'HAS_DOCUMENTS', 'Ce projet a des documents rattachés : détachez-les ou passez le projet en « annulé »'); }
    await conn.query('DELETE FROM projects WHERE id = ?', [p.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'project.delete', entityType: 'projects', entityId: req.params.id, ip: req.ip, meta: { code: p.code } });
  });
  res.status(204).end();
}));

// Documents rattachables : non encore rattachés à un projet
router.get('/:id/linkable', requirePermission('project.read'), validate({ params: idParam, query: z.object({ docType, q: z.string().trim().max(60).optional() }) }), asyncHandler(async (req, res) => {
  await find(pool, req.auth.companyId, req.params.id); const D = DOCS[req.query.docType]; const params = [req.auth.companyId]; let like = '';
  if (req.query.q) { like = ` AND (${D.num} LIKE ? OR x.name LIKE ?)`; const l = `%${escapeLike(req.query.q)}%`; params.push(l, l); }
  const [rows] = await pool.query(`SELECT d.public_id, ${D.num} AS number, d.status, DATE_FORMAT(${D.date},'%Y-%m-%d') AS dt, ${D.ht} AS ht, x.name AS party_name FROM ${D.table} d JOIN ${D.party} x ON x.id = d.${D.pcol} WHERE d.company_id = ? AND d.project_id IS NULL AND d.status <> 'cancelled'${kindWhere(D)}${like} ORDER BY d.id DESC LIMIT 15`, params);
  res.json({ data: rows.map((r) => ({ id: r.public_id, number: r.number ?? 'Brouillon', status: r.status, date: r.dt, totalHt: r.ht, partyName: r.party_name })) });
}));

router.post('/:id/documents', requirePermission('project.write'), validate({ params: idParam, body: z.object({ docType, docId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const D = DOCS[req.body.docType];
  await withTransaction(async (conn) => {
    const p = await find(conn, req.auth.companyId, req.params.id, true);
    if (['completed', 'cancelled'].includes(p.status)) throw new HttpError(409, 'PROJECT_CLOSED', 'Projet terminé ou annulé : rattachement impossible');
    const [[d]] = await conn.query(`SELECT d.id, d.project_id, d.${D.pcol} AS party_id FROM ${D.table} d WHERE d.company_id = ? AND d.public_id = ?${kindWhere(D)} FOR UPDATE`, [req.auth.companyId, req.body.docId]);
    if (!d) throw new HttpError(404, 'NOT_FOUND', 'Document introuvable');
    if (d.project_id) throw new HttpError(409, 'ALREADY_LINKED', d.project_id === p.id ? 'Document déjà rattaché à ce projet' : 'Document déjà rattaché à un autre projet');
    if (D.side === 'sales' && p.client_id && Number(d.party_id) !== Number(p.client_id)) throw new HttpError(422, 'CLIENT_MISMATCH', 'Ce document concerne un autre client que celui du projet');
    await conn.query(`UPDATE ${D.table} SET project_id = ? WHERE id = ?`, [p.id, d.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'project.link', entityType: 'projects', entityId: req.params.id, ip: req.ip, meta: { docType: req.body.docType, docId: req.body.docId } });
  });
  const p = await find(pool, req.auth.companyId, req.params.id);
  res.json({ data: { summary: await summary(req.auth.companyId, p.id, p.budget) } });
}));

router.delete('/:id/documents/:docType/:docId', requirePermission('project.write'), validate({ params: z.object({ id: z.string().uuid(), docType, docId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const D = DOCS[req.params.docType];
  await withTransaction(async (conn) => {
    const p = await find(conn, req.auth.companyId, req.params.id, true);
    const [r] = await conn.query(`UPDATE ${D.table} d SET d.project_id = NULL WHERE d.company_id = ? AND d.public_id = ? AND d.project_id = ?${kindWhere(D)}`, [req.auth.companyId, req.params.docId, p.id]);
    if (!r.affectedRows) throw new HttpError(404, 'NOT_FOUND', 'Document non rattaché à ce projet');
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'project.unlink', entityType: 'projects', entityId: req.params.id, ip: req.ip, meta: { docType: req.params.docType, docId: req.params.docId } });
  });
  res.status(204).end();
}));

export default router;
