// Notes de débours : sommes avancées pour le compte d'un client (ventes) ou reçues d'un tiers (achats).
// Un débours est reporté à l'identique : aucune TVA, aucune marge, devise de l'entreprise uniquement.
// Brouillon modifiable/supprimable ; validation = numéro définitif (DEB-/DBA-) et document figé ; annulation avec motif, jamais de suppression.
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { nextDocNumber } from '../../core/numbering.js';
import { fromScaled, toScaled } from '../../core/calc.js';
import { listQuerySchema, escapeLike } from '../../core/list.js';
import { applyAdvanced, rangeShape, pageOf, isExport, exportCsv, csvDate, csvMoney, parseSnap } from '../../core/list-filters.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { clientSnapshot, history, idParam, loadCompany, todayTunis } from '../sales/common.js';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const opt = (s) => z.preprocess((v) => (v === '' ? null : v), s.nullable().optional());
const amount = z.union([z.string(), z.number()]).transform((v) => String(v).trim().replace(',', '.')).refine((s) => /^\d{1,12}(\.\d{1,3})?$/.test(s) && Number(s) > 0, 'Montant positif (3 décimales max)');
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const KINDS = {
  sales: { kind: 'sales', prefix: 'DEB', docType: 'expense_note_sales', party: 'clients', col: 'client_id', key: 'clientId', label: 'Client' },
  purchase: { kind: 'purchase', prefix: 'DBA', docType: 'expense_note_purchase', party: 'suppliers', col: 'supplier_id', key: 'supplierId', label: 'Fournisseur' },
};

export function makeExpenseRouter(kindName) {
  const K = KINDS[kindName]; const router = Router(); router.use(authenticate);
  const lineSchema = z.object({ description: z.string().trim().min(2, 'Désignation requise').max(255), payee: opt(z.string().trim().max(160)), proofRef: opt(z.string().trim().max(80)), amount });
  const body = z.object({ [K.key]: z.string().uuid(), noteDate: iso, projectId: opt(z.string().uuid()), notes: opt(z.string().trim().max(3000)), lines: z.array(lineSchema).min(1, 'Au moins une ligne').max(100) });

  const SEL = `SELECT n.*, DATE_FORMAT(n.note_date,'%Y-%m-%d') AS d_s, pr.public_id AS project_pid, pr.code AS project_code, pr.name AS project_name FROM expense_notes n LEFT JOIN projects pr ON pr.id = n.project_id`;
  const load = async (conn, companyId, publicId, forUpdate = false) => {
    const sql = forUpdate ? "SELECT n.*, DATE_FORMAT(n.note_date,'%Y-%m-%d') AS d_s FROM expense_notes n WHERE n.company_id = ? AND n.kind = ? AND n.public_id = ? FOR UPDATE" : `${SEL} WHERE n.company_id = ? AND n.kind = ? AND n.public_id = ?`;
    const [[n]] = await conn.query(sql, [companyId, K.kind, publicId]);
    if (!n) throw new HttpError(404, 'NOT_FOUND', 'Note de débours introuvable');
    return n;
  };
  const dto = async (conn, n) => {
    const [ls] = await conn.query('SELECT description, payee, proof_ref, amount FROM expense_note_lines WHERE expense_note_id = ? ORDER BY position', [n.id]);
    const snap = parse(n.party_snapshot);
    return { id: n.public_id, kind: K.kind, number: n.number, status: n.status, partyId: null, party: snap, partyName: snap.name, date: n.d_s, currency: n.currency, total: n.total, notes: n.notes, cancelReason: n.cancel_reason,
      project: n.project_pid ? { id: n.project_pid, code: n.project_code, name: n.project_name } : null, lines: ls.map((l) => ({ description: l.description, payee: l.payee, proofRef: l.proof_ref, amount: l.amount })), createdAt: n.created_at };
  };
  const out = async (companyId, publicId) => { const n = await load(pool, companyId, publicId); const d = await dto(pool, n); const [[p]] = await pool.query(`SELECT x.public_id FROM ${K.party} x WHERE x.id = ?`, [n[K.col]]); d.partyId = p.public_id; return d; };

  async function resolve(conn, auth, b) {
    const [[party]] = await conn.query(`SELECT * FROM ${K.party} WHERE company_id = ? AND public_id = ?`, [auth.companyId, b[K.key]]);
    if (!party) throw new HttpError(422, 'UNKNOWN_REFERENCE', `${K.label} introuvable`);
    if (party.status !== 'active') throw new HttpError(422, 'PARTY_ARCHIVED', `${K.label} archivé`);
    let projectId = null;
    if (b.projectId) { const [[pr]] = await conn.query('SELECT id FROM projects WHERE company_id = ? AND public_id = ?', [auth.companyId, b.projectId]); if (!pr) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Projet introuvable'); projectId = pr.id; }
    if (b.noteDate > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date ne peut pas être dans le futur');
    const total = b.lines.reduce((s, l) => s + toScaled(l.amount, 3), 0n);
    return { party, projectId, total: fromScaled(total, 3) };
  }
  const writeLines = async (conn, id, lines) => { await conn.query('DELETE FROM expense_note_lines WHERE expense_note_id = ?', [id]); for (const [i, l] of lines.entries()) await conn.query('INSERT INTO expense_note_lines (expense_note_id, position, description, payee, proof_ref, amount) VALUES (?,?,?,?,?,?)', [id, i + 1, l.description, l.payee ?? null, l.proofRef ?? null, fromScaled(toScaled(l.amount, 3), 3)]); };

  router.get(['/', '/export'], requirePermission('expense_note.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ ...rangeShape, status: z.enum(['draft', 'validated', 'cancelled']).optional(), projectId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
    const q = req.query; const where = ['n.company_id = ?', 'n.kind = ?']; const params = [req.auth.companyId, K.kind];
    if (q.status) { where.push('n.status = ?'); params.push(q.status); } if (q.projectId) { where.push('pr.public_id = ?'); params.push(q.projectId); }
    applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'n', dateCol: 'note_date', totalCol: 'total', partyCols: ['n.number', "JSON_UNQUOTE(JSON_EXTRACT(n.party_snapshot,'$.name'))"], notesCol: 'notes' });
    const [[agg]] = await pool.query(`SELECT COUNT(*) AS total FROM expense_notes n LEFT JOIN projects pr ON pr.id = n.project_id WHERE ${where.join(' AND ')}`, params);
    const [rows] = await pool.query(`${SEL} WHERE ${where.join(' AND ')} ORDER BY n.note_date DESC, n.id DESC LIMIT ? OFFSET ?`, [...params, pageOf(req).limit, pageOf(req).offset]);
    if (isExport(req)) return exportCsv(req, res, { rows, total: agg.total, file: 'notes-de-frais.csv', action: 'expense_note.export', entity: 'expense_notes', headers: ['N°', 'Statut', 'Date', 'Tiers', 'Projet', 'Devise', 'Total'], row: (n) => [n.number ?? '', ({ draft: 'Brouillon', validated: 'Validé', cancelled: 'Annulé' })[n.status] ?? n.status, csvDate(n.d_s), parseSnap(n.party_snapshot).name ?? '', n.project_code ?? '', n.currency, csvMoney(n.total)] });
    res.json({ data: rows.map((n) => ({ id: n.public_id, number: n.number, status: n.status, partyName: parse(n.party_snapshot).name, date: n.d_s, total: n.total, currency: n.currency, project: n.project_pid ? { id: n.project_pid, code: n.project_code } : null })), meta: { page: q.page, limit: q.limit, total: agg.total, pages: Math.max(1, Math.ceil(agg.total / q.limit)) } });
  }));
  router.get('/:id', requirePermission('expense_note.read'), validate({ params: idParam }), asyncHandler(async (req, res) => res.json({ data: await out(req.auth.companyId, req.params.id) })));
  router.get('/:id/history', requirePermission('expense_note.read'), validate({ params: idParam }), asyncHandler(async (req, res) => { await load(pool, req.auth.companyId, req.params.id); res.json({ data: await history(req.auth.companyId, 'expense_notes', req.params.id) }); }));

  router.post('/', requirePermission('expense_note.write'), validate({ body }), asyncHandler(async (req, res) => {
    const publicId = newPublicId();
    await withTransaction(async (conn) => {
      const r = await resolve(conn, req.auth, req.body); const company = await loadCompany(conn, req.auth.companyId);
      const [ins] = await conn.query(`INSERT INTO expense_notes (public_id, company_id, kind, status, ${K.col}, party_snapshot, note_date, currency, total, project_id, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [publicId, req.auth.companyId, K.kind, 'draft', r.party.id, JSON.stringify(clientSnapshot(r.party)), req.body.noteDate, company.currency, r.total, r.projectId, req.body.notes ?? null, req.auth.userId]);
      await writeLines(conn, ins.insertId, req.body.lines);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'expense_note.create', entityType: 'expense_notes', entityId: publicId, ip: req.ip, meta: { kind: K.kind, total: r.total } });
    });
    res.status(201).json({ data: await out(req.auth.companyId, publicId) });
  }));
  router.put('/:id', requirePermission('expense_note.write'), validate({ params: idParam, body }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const n = await load(conn, req.auth.companyId, req.params.id, true);
      if (n.status !== 'draft') throw new HttpError(409, 'NOT_DRAFT', 'Seul un brouillon est modifiable');
      const r = await resolve(conn, req.auth, req.body);
      await conn.query(`UPDATE expense_notes SET ${K.col} = ?, party_snapshot = ?, note_date = ?, total = ?, project_id = ?, notes = ? WHERE id = ?`, [r.party.id, JSON.stringify(clientSnapshot(r.party)), req.body.noteDate, r.total, r.projectId, req.body.notes ?? null, n.id]);
      await writeLines(conn, n.id, req.body.lines);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'expense_note.update', entityType: 'expense_notes', entityId: req.params.id, ip: req.ip, meta: { total: r.total } });
    });
    res.json({ data: await out(req.auth.companyId, req.params.id) });
  }));
  router.delete('/:id', requirePermission('expense_note.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const n = await load(conn, req.auth.companyId, req.params.id, true);
      if (n.status !== 'draft') throw new HttpError(409, 'NOT_DRAFT', 'Seul un brouillon peut être supprimé ; une note validée s\'annule avec un motif');
      await conn.query('DELETE FROM expense_notes WHERE id = ?', [n.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'expense_note.delete', entityType: 'expense_notes', entityId: req.params.id, ip: req.ip, meta: {} });
    });
    res.status(204).end();
  }));
  router.post('/:id/validate', requirePermission('expense_note.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const n = await load(conn, req.auth.companyId, req.params.id, true);
      if (n.status !== 'draft') throw new HttpError(409, 'NOT_DRAFT', 'Note déjà validée ou annulée');
      const [[{ c }]] = await conn.query('SELECT COUNT(*) AS c FROM expense_note_lines WHERE expense_note_id = ?', [n.id]);
      if (!c) throw new HttpError(422, 'NO_LINES', 'Aucune ligne');
      const series = n.d_s.slice(0, 4); const number = await nextDocNumber(conn, req.auth.companyId, K.docType, series);
      await conn.query("UPDATE expense_notes SET status = 'validated', number = ? WHERE id = ?", [number, n.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'expense_note.validate', entityType: 'expense_notes', entityId: req.params.id, ip: req.ip, meta: { number, total: n.total } });
    });
    res.json({ data: await out(req.auth.companyId, req.params.id) });
  }));
  router.post('/:id/cancel', requirePermission('expense_note.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis').max(255) }) }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const n = await load(conn, req.auth.companyId, req.params.id, true);
      if (n.status !== 'validated') throw new HttpError(409, 'NOT_VALIDATED', 'Seule une note validée peut être annulée');
      await conn.query("UPDATE expense_notes SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [req.body.reason, n.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'expense_note.cancel', entityType: 'expense_notes', entityId: req.params.id, ip: req.ip, meta: { reason: req.body.reason } });
    });
    res.json({ data: await out(req.auth.companyId, req.params.id) });
  }));
  return router;
}
export const salesExpenseRouter = makeExpenseRouter('sales');
export const purchaseExpenseRouter = makeExpenseRouter('purchase');
