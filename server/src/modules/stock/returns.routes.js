// Bons de retour client (vente) et retours fournisseur (achat).
// - Retour client : rattaché à un bon de livraison VALIDÉ ; la validation remet en stock au coût de la sortie d'origine.
// - Retour fournisseur : rattaché à une réception VALIDÉE ; la validation sort du stock au coût moyen courant.
// Quantité retournable = quantité du document d'origine − retours brouillon et validés (contrôle refait sous verrou à la validation).
// Aucun montant ici : la correction financière se fait par avoir (client) ou avoir fournisseur saisi séparément.
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { nextDocNumber } from '../../core/numbering.js';
import { fromScaled, toScaled } from '../../core/calc.js';
import { listQuerySchema, escapeLike, orderBy } from '../../core/list.js';
import { applyAdvanced, rangeShape, pageOf, isExport, exportCsv, csvDate, csvMoney, parseSnap } from '../../core/list-filters.js';
import { clientSnapshot, companySnapshot, history, idParam, qtySchema, todayTunis } from '../sales/common.js';
import { ensureDefaultWarehouse, moveStock, reverseSource } from './stock.service.js';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const opt = (s) => z.preprocess((v) => (v === '' ? null : v), s.nullable().optional());
const body = z.object({
  sourceId: z.string().uuid(), returnDate: iso, reason: z.string().trim().min(3, 'Motif requis').max(255), notes: opt(z.string().trim().max(3000)),
  lines: z.array(z.object({ sourceLineId: z.coerce.number().int().positive(), quantity: qtySchema })).min(1, 'Au moins une ligne').max(200),
});
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

const KINDS = {
  sales: {
    perm: 'sales_return', prefix: 'BRT', docType: 'sales_return', table: 'sales_returns', lines: 'sales_return_lines', fk: 'delivery_note_id',
    src: 'delivery_notes', srcLines: 'delivery_note_lines', srcParentFk: 'delivery_note_id', srcDate: 'delivery_date', srcType: 'delivery_note', srcLabel: 'bon de livraison',
    party: 'clients', partyCol: 'client_id', snap: 'client_snapshot', origLines: 'sales_order_lines', stockKind: 'return_in', sign: '', label: 'Bon de retour',
    audit: 'sales_return', moveType: 'sales_return',
  },
  purchase: {
    perm: 'purchase_return', prefix: 'RF', docType: 'purchase_return', table: 'purchase_returns', lines: 'purchase_return_lines', fk: 'receipt_id',
    src: 'purchase_receipts', srcLines: 'purchase_receipt_lines', srcParentFk: 'purchase_receipt_id', srcDate: 'receipt_date', srcType: 'purchase_receipt', srcLabel: 'réception',
    party: 'suppliers', partyCol: 'supplier_id', snap: 'supplier_snapshot', origLines: 'purchase_order_lines', stockKind: 'return_out', sign: '-', label: 'Retour fournisseur',
    audit: 'purchase_return', moveType: 'purchase_return',
  },
};

export function makeReturnsRouter(kind) {
  const K = KINDS[kind];
  const router = Router();
  router.use(authenticate);

  const findSource = async (conn, companyId, publicId, { forUpdate = false } = {}) => {
    const [[s]] = await conn.query(
      `SELECT s.*, DATE_FORMAT(s.${K.srcDate},'%Y-%m-%d') AS src_date_s, p.public_id AS party_pid, p.name AS party_name FROM ${K.src} s JOIN ${K.party} p ON p.id = s.${K.partyCol}
       WHERE s.company_id = ? AND s.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId]);
    if (!s) throw new HttpError(404, 'NOT_FOUND', `${K.srcLabel[0].toUpperCase()}${K.srcLabel.slice(1)} introuvable`);
    if (s.source_invoice_id) throw new HttpError(409, 'RETURN_NOT_SUPPORTED', `Ce document a été généré depuis une facture : pour un retour, établissez un avoir${kind === 'sales' ? '' : ' fournisseur'} ou une régularisation de stock`);
    return s;
  };
  const findReturn = async (conn, companyId, publicId, { forUpdate = false } = {}) => {
    const [[r]] = await conn.query(
      `SELECT r.*, DATE_FORMAT(r.return_date,'%Y-%m-%d') AS return_date_s, p.public_id AS party_pid, s.public_id AS src_pid, s.number AS src_number, w.public_id AS wh_pid, w.name AS wh_name
       FROM ${K.table} r JOIN ${K.party} p ON p.id = r.${K.partyCol} JOIN ${K.src} s ON s.id = r.${K.fk} LEFT JOIN warehouses w ON w.id = r.warehouse_id
       WHERE r.company_id = ? AND r.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId]);
    if (!r) throw new HttpError(404, 'NOT_FOUND', `${K.label} introuvable`);
    return r;
  };
  // lignes du document d'origine avec quantité déjà retournée (brouillons + validés), hors retour `excludeId`
  const returnable = async (conn, source, excludeId = 0) => {
    const [lines] = await conn.query(`SELECT id, position, description, quantity, unit FROM ${K.srcLines} WHERE ${K.srcParentFk} = ? ORDER BY position`, [source.id]);
    const [used] = await conn.query(
      `SELECT rl.source_line_id, SUM(rl.quantity) AS q FROM ${K.lines} rl JOIN ${K.table} r ON r.id = rl.return_id WHERE r.${K.fk} = ? AND r.status IN ('draft','validated') AND r.id <> ? GROUP BY rl.source_line_id`, [source.id, excludeId]);
    const usedBy = new Map(used.map((u) => [Number(u.source_line_id), toScaled(u.q, 4)]));
    return lines.map((l) => {
      const ret = usedBy.get(Number(l.id)) ?? 0n; const left = toScaled(l.quantity, 4) - ret;
      return { id: l.id, position: l.position, description: l.description, unit: l.unit, quantity: l.quantity, returnedQuantity: fromScaled(ret, 4), returnableQuantity: fromScaled(left > 0n ? left : 0n, 4) };
    });
  };
  const checkLines = async (conn, source, wanted, excludeId = 0) => {
    const avail = new Map((await returnable(conn, source, excludeId)).map((l) => [Number(l.id), l]));
    const seen = new Set(); const out = [];
    for (const w of wanted) {
      const l = avail.get(Number(w.sourceLineId));
      if (!l) throw new HttpError(422, 'UNKNOWN_REFERENCE', `Ligne ${w.sourceLineId} absente du document d'origine`);
      if (seen.has(l.id)) throw new HttpError(422, 'DUPLICATE_LINE', 'Ligne en double');
      seen.add(l.id);
      if (toScaled(w.quantity, 4) <= 0n) throw new HttpError(422, 'INVALID_QUANTITY', 'Quantité positive requise');
      if (toScaled(w.quantity, 4) > toScaled(l.returnableQuantity, 4)) throw new HttpError(422, 'RETURN_EXCEEDS_SOURCE', `Ligne ${l.position} : quantité retournée (${Number(w.quantity)}) supérieure au reste retournable (${Number(l.returnableQuantity)})`);
      out.push({ ...l, qty: w.quantity });
    }
    return out;
  };
  const notFuture = (d) => { if (d > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date du retour est dans le futur'); };
  const writeLines = async (conn, returnId, lines) => {
    await conn.query(`DELETE FROM ${K.lines} WHERE return_id = ?`, [returnId]);
    let pos = 1;
    for (const l of lines) await conn.query(`INSERT INTO ${K.lines} (return_id, source_line_id, position, description, quantity, unit) VALUES (?,?,?,?,?,?)`, [returnId, l.id, pos++, l.description, l.qty, l.unit]);
  };

  async function dto(conn, companyId, publicId) {
    const r = await findReturn(conn, companyId, publicId);
    const [lines] = await conn.query(`SELECT * FROM ${K.lines} WHERE return_id = ? ORDER BY position`, [r.id]);
    const snap = parse(r[K.snap]);
    const [mv] = await conn.query("SELECT COUNT(*) AS n FROM stock_movements WHERE company_id = ? AND source_type = ? AND source_id = ? AND kind = ?", [companyId, K.moveType, r.public_id, K.stockKind]);
    return {
      id: r.public_id, kind, number: r.number, status: r.status, partyId: r.party_pid, partyName: snap.name, party: snap, company: r.company_snapshot ? parse(r.company_snapshot) : null,
      source: { id: r.src_pid, number: r.src_number }, warehouse: r.wh_pid ? { id: r.wh_pid, name: r.wh_name } : null, returnDate: r.return_date_s, reason: r.reason, notes: r.notes, cancelReason: r.cancel_reason,
      lines: lines.map((l) => ({ id: l.id, sourceLineId: l.source_line_id, position: l.position, description: l.description, quantity: l.quantity, unit: l.unit })),
      stockMovements: mv[0].n, createdAt: r.created_at,
    };
  }

  router.get(['/', '/export'], requirePermission(`${K.perm}.read`), validate({ query: listQuerySchema.omit({ status: true }).extend({ ...rangeShape, status: z.enum(['draft', 'validated', 'cancelled']).optional(), sourceId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
    const q = req.query; const where = ['r.company_id = ?']; const params = [req.auth.companyId];
    if (q.status) { where.push('r.status = ?'); params.push(q.status); }
    if (q.sourceId) { where.push('s.public_id = ?'); params.push(q.sourceId); }
    applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'r', dateCol: 'return_date', partyCols: ['r.number', 'p.name', 's.number', 'r.reason'] });
    const from = `FROM ${K.table} r JOIN ${K.party} p ON p.id = r.${K.partyCol} JOIN ${K.src} s ON s.id = r.${K.fk}`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
    const SORT = { id: 'r.id', number: 'r.number', date: 'r.return_date', party: 'p.name' };
    const [rows] = await pool.query(`SELECT r.public_id, r.number, r.status, r.reason, DATE_FORMAT(r.return_date,'%Y-%m-%d') AS d, r.${K.snap} AS snap, s.public_id AS src_pid, s.number AS src_number ${from} WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy(q.sort ?? 'date', q.order === 'asc' && !q.sort ? 'desc' : q.order, SORT, 'date')} LIMIT ? OFFSET ?`, [...params, pageOf(req).limit, pageOf(req).offset]);
    if (isExport(req)) return exportCsv(req, res, { rows, total, file: `${kind === 'sales' ? 'retours-clients' : 'retours-fournisseurs'}.csv`, action: 'stock_return.export', entity: K.table, headers: ['N°', 'Statut', 'Date', 'Tiers', 'Document d\'origine', 'Motif'], row: (r) => [r.number ?? '', ({ draft: 'Brouillon', validated: 'Validé', cancelled: 'Annulé' })[r.status] ?? r.status, csvDate(r.d), parseSnap(r.snap).name ?? '', r.src_number ?? '', r.reason ?? ''] });
    res.json({ data: rows.map((r) => ({ id: r.public_id, number: r.number, status: r.status, returnDate: r.d, reason: r.reason, partyName: parse(r.snap).name, source: { id: r.src_pid, number: r.src_number } })), meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
  }));

  // quantités retournables d'un document d'origine (alimente la fenêtre de création)
  router.get('/source/:id', requirePermission(`${K.perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const s = await findSource(pool, req.auth.companyId, req.params.id);
    res.json({ data: { id: s.public_id, number: s.number, status: s.status, partyName: s.party_name, date: s.src_date_s, lines: await returnable(pool, s) } });
  }));
  router.get('/:id', requirePermission(`${K.perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => { res.json({ data: await dto(pool, req.auth.companyId, req.params.id) }); }));
  router.get('/:id/history', requirePermission(`${K.perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await findReturn(pool, req.auth.companyId, req.params.id);
    res.json({ data: await history(req.auth.companyId, K.table, req.params.id) });
  }));

  router.post('/', requirePermission(`${K.perm}.write`), validate({ body }), asyncHandler(async (req, res) => {
    const publicId = newPublicId();
    await withTransaction(async (conn) => {
      const s = await findSource(conn, req.auth.companyId, req.body.sourceId, { forUpdate: true });
      if (s.status !== 'validated') throw new HttpError(409, 'INVALID_STATE', `Le ${K.srcLabel} doit être validé`);
      notFuture(req.body.returnDate);
      if (req.body.returnDate < s.src_date_s) throw new HttpError(422, 'INVALID_DATE', `Le retour précède le ${K.srcLabel}`);
      const lines = await checkLines(conn, s, req.body.lines);
      const [[party]] = await conn.query(`SELECT * FROM ${K.party} WHERE id = ?`, [s[K.partyCol]]);
      const [r] = await conn.query(`INSERT INTO ${K.table} (public_id, company_id, status, ${K.fk}, ${K.partyCol}, warehouse_id, ${K.snap}, return_date, reason, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [publicId, req.auth.companyId, 'draft', s.id, s[K.partyCol], s.warehouse_id ?? null, JSON.stringify(clientSnapshot(party)), req.body.returnDate, req.body.reason, req.body.notes ?? null, req.auth.userId]);
      await writeLines(conn, r.insertId, lines);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${K.audit}.create`, entityType: K.table, entityId: publicId, ip: req.ip, meta: { source: s.number, lines: lines.length } });
    });
    res.status(201).json({ data: await dto(pool, req.auth.companyId, publicId) });
  }));

  router.put('/:id', requirePermission(`${K.perm}.write`), validate({ params: idParam, body: body.omit({ sourceId: true }) }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await findReturn(conn, req.auth.companyId, req.params.id, { forUpdate: true });
      if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Seul un brouillon peut être modifié');
      const [[s]] = await conn.query(`SELECT * FROM ${K.src} WHERE id = ? FOR UPDATE`, [cur[K.fk]]);
      s.src_date_s = (await findSource(conn, req.auth.companyId, cur.src_pid)).src_date_s;
      notFuture(req.body.returnDate);
      if (req.body.returnDate < s.src_date_s) throw new HttpError(422, 'INVALID_DATE', `Le retour précède le ${K.srcLabel}`);
      const lines = await checkLines(conn, s, req.body.lines, cur.id);
      await conn.query(`UPDATE ${K.table} SET return_date = ?, reason = ?, notes = ? WHERE id = ?`, [req.body.returnDate, req.body.reason, req.body.notes ?? null, cur.id]);
      await writeLines(conn, cur.id, lines);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${K.audit}.update`, entityType: K.table, entityId: cur.public_id, ip: req.ip });
    });
    res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
  }));

  router.delete('/:id', requirePermission(`${K.perm}.delete`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await findReturn(conn, req.auth.companyId, req.params.id, { forUpdate: true });
      if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Seul un brouillon peut être supprimé ; un retour validé s\'annule avec un motif');
      await conn.query(`DELETE FROM ${K.table} WHERE id = ?`, [cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${K.audit}.delete`, entityType: K.table, entityId: cur.public_id, ip: req.ip });
    });
    res.status(204).end();
  }));

  router.post('/:id/validate', requirePermission(`${K.perm}.validate`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await findReturn(conn, req.auth.companyId, req.params.id, { forUpdate: true });
      if (cur.status !== 'draft') throw new HttpError(409, 'INVALID_TRANSITION', 'Ce retour est déjà validé ou annulé');
      notFuture(cur.return_date_s);
      const [[s]] = await conn.query(`SELECT * FROM ${K.src} WHERE id = ? FOR UPDATE`, [cur[K.fk]]);
      if (s.status !== 'validated') throw new HttpError(409, 'INVALID_STATE', `Le ${K.srcLabel} n'est plus validé`);
      const [rows] = await conn.query(`SELECT source_line_id, quantity FROM ${K.lines} WHERE return_id = ?`, [cur.id]);
      await checkLines(conn, s, rows.map((l) => ({ sourceLineId: l.source_line_id, quantity: String(l.quantity) })), cur.id);
      const series = cur.return_date_s.slice(0, 4);
      const number = await nextDocNumber(conn, req.auth.companyId, K.docType, series);
      const whId = cur.warehouse_id ?? s.warehouse_id ?? await ensureDefaultWarehouse(conn, req.auth.companyId, req.auth.userId);
      const [tracked] = await conn.query(
        `SELECT rl.id, rl.quantity, rl.source_line_id, ol.product_id FROM ${K.lines} rl JOIN ${K.srcLines} sl ON sl.id = rl.source_line_id JOIN ${K.origLines} ol ON ol.id = sl.order_line_id JOIN products p ON p.id = ol.product_id
         WHERE rl.return_id = ? AND p.track_stock = 1 AND p.type = 'product' ORDER BY rl.position`, [cur.id]);
      if (tracked.length) {
        const [[wh]] = await conn.query('SELECT status, name FROM warehouses WHERE id = ? AND company_id = ?', [whId, req.auth.companyId]);
        if (wh.status !== 'active') throw new HttpError(422, 'WAREHOUSE_ARCHIVED', `L'entrepôt « ${wh.name} » est archivé : choisissez un autre entrepôt`);
        const items = [];
        for (const t of tracked) {
          let unitCost;
          if (kind === 'sales') { // le retour rentre au coût auquel la marchandise est sortie
            const [[m]] = await conn.query("SELECT unit_cost FROM stock_movements WHERE company_id = ? AND source_type = 'delivery_note' AND source_id = ? AND source_line_id = ? AND kind = 'delivery' LIMIT 1", [req.auth.companyId, s.public_id, t.source_line_id]);
            unitCost = m?.unit_cost;
          }
          items.push({ productId: t.product_id, warehouseId: whId, kind: K.stockKind, quantity: `${K.sign}${t.quantity}`, unitCost, date: cur.return_date_s, reason: `${K.label} ${number}`, source: { type: K.moveType, id: cur.public_id, number, lineId: t.id } });
        }
        await moveStock(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, items);
      }
      const [[party]] = await conn.query(`SELECT * FROM ${K.party} WHERE id = ?`, [cur[K.partyCol]]);
      await conn.query(`UPDATE ${K.table} SET warehouse_id = ?, status = 'validated', number = ?, series = ?, validated_at = UTC_TIMESTAMP(), validated_by = ?, ${K.snap} = ?, company_snapshot = ? WHERE id = ?`,
        [whId, number, series, req.auth.userId, JSON.stringify(clientSnapshot(party)), JSON.stringify(await companySnapshot(conn, req.auth.companyId)), cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${K.audit}.validate`, entityType: K.table, entityId: cur.public_id, ip: req.ip, meta: { number, source: s.number, stockLines: tracked.length } });
    });
    res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
  }));

  router.post('/:id/cancel', requirePermission(`${K.perm}.validate`), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await findReturn(conn, req.auth.companyId, req.params.id, { forUpdate: true });
      if (cur.status !== 'validated') throw new HttpError(409, 'INVALID_TRANSITION', 'Seul un retour validé peut être annulé (un brouillon se supprime)');
      await reverseSource(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, { companyId: req.auth.companyId, type: K.moveType, id: cur.public_id, number: cur.number, kinds: [K.stockKind], reverseKind: 'cancellation', date: todayTunis(), reason: `Annulation ${cur.number}` });
      await conn.query(`UPDATE ${K.table} SET status = 'cancelled', cancel_reason = ? WHERE id = ?`, [req.body.reason, cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${K.audit}.cancel`, entityType: K.table, entityId: cur.public_id, ip: req.ip, meta: { number: cur.number, reason: req.body.reason } });
    });
    res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
  }));
  return router;
}

export const salesReturnsRouter = makeReturnsRouter('sales');
export const purchaseReturnsRouter = makeReturnsRouter('purchase');
