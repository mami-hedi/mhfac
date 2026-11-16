// Bons d'entrée, de prélèvement (sortie) et de transfert : brouillon -> validé (numéro + mouvements) -> annulé (mouvements inverses).
import { fileSafe } from '../../utils/filename.js';
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { nextDocNumber } from '../../core/numbering.js';
import { listQuerySchema, escapeLike } from '../../core/list.js';
import { applyAdvanced, rangeShape, pageOf, isExport, exportCsv, csvDate, csvMoney, parseSnap } from '../../core/list-filters.js';
import { history, idParam, todayTunis } from '../sales/common.js';
import { ensureDefaultWarehouse, findWarehouse, moveStock, reverseSource } from './stock.service.js';
import { costField, iso, opt, qtyPos } from './schemas.js';
import { renderStockVoucherPdf } from './voucher-pdf.js';

const TYPES = {
  entry: { prefix: 'BEN', label: "Bon d'entrée", action: 'stock_entry' },
  withdrawal: { prefix: 'BPR', label: 'Bon de prélèvement', action: 'stock_withdrawal' },
  transfer: { prefix: 'BTR', label: 'Bon de transfert', action: 'stock_transfer' },
};

export default function vouchersRouter(type) {
  const T = TYPES[type]; const router = Router();
  const body = z.object({
    warehouseId: z.string().uuid(), toWarehouseId: opt(z.string().uuid()).optional(), date: iso,
    reason: opt(z.string().trim().max(255)).optional(), notes: opt(z.string().trim().max(3000)).optional(),
    lines: z.array(z.object({ productId: z.string().uuid(), quantity: qtyPos, unitCost: opt(costField).optional() })).min(1, 'Au moins une ligne').max(200),
  }).superRefine((b, ctx) => {
    if (type === 'transfer' && !b.toWarehouseId) ctx.addIssue({ code: 'custom', path: ['toWarehouseId'], message: "Entrepôt de destination requis" });
    if (type === 'transfer' && b.toWarehouseId === b.warehouseId) ctx.addIssue({ code: 'custom', path: ['toWarehouseId'], message: 'Origine et destination identiques' });
    if (type === 'withdrawal' && !(b.reason && b.reason.length >= 3)) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Motif requis (3 caractères minimum)' });
    if (new Set(b.lines.map((l) => l.productId)).size !== b.lines.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Article en double : regroupez les quantités' });
  });

  async function find(conn, companyId, publicId, forUpdate = false) {
    const [[v]] = await conn.query(`SELECT v.*, DATE_FORMAT(v.voucher_date,'%Y-%m-%d') AS date_s, w.public_id AS wh_pid, w.name AS wh_name, t.public_id AS to_pid, t.name AS to_name
      FROM stock_vouchers v JOIN warehouses w ON w.id = v.warehouse_id LEFT JOIN warehouses t ON t.id = v.to_warehouse_id WHERE v.company_id = ? AND v.public_id = ? AND v.type = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId, type]);
    if (!v) throw new HttpError(404, 'NOT_FOUND', `${T.label} introuvable`);
    return v;
  }
  const dto = async (conn, companyId, publicId) => {
    const v = await find(conn, companyId, publicId);
    const [lines] = await conn.query('SELECT l.*, p.public_id AS product_pid, p.name, p.sku, p.unit FROM stock_voucher_lines l JOIN products p ON p.id = l.product_id WHERE l.voucher_id = ? ORDER BY l.position', [v.id]);
    return { id: v.public_id, type, number: v.number, status: v.status, date: v.date_s, warehouse: { id: v.wh_pid, name: v.wh_name }, toWarehouse: v.to_pid ? { id: v.to_pid, name: v.to_name } : null, reason: v.reason, notes: v.notes, cancelReason: v.cancel_reason, createdAt: v.created_at,
      lines: lines.map((l) => ({ id: l.id, productId: l.product_pid, name: l.name, sku: l.sku, unit: l.unit, quantity: l.quantity, unitCost: l.unit_cost })) };
  };
  async function writeLines(conn, voucherId, companyId, lines) {
    await conn.query('DELETE FROM stock_voucher_lines WHERE voucher_id = ?', [voucherId]);
    const [prods] = await conn.query('SELECT id, public_id, track_stock, type, name FROM products WHERE company_id = ? AND public_id IN (?)', [companyId, lines.map((l) => l.productId)]);
    const byPid = new Map(prods.map((p) => [p.public_id, p]));
    for (const [i, l] of lines.entries()) {
      const p = byPid.get(l.productId);
      if (!p) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Article introuvable');
      if (!p.track_stock || p.type !== 'product') throw new HttpError(422, 'NOT_TRACKED', `« ${p.name} » n'est pas suivi en stock`);
      await conn.query('INSERT INTO stock_voucher_lines (voucher_id, position, product_id, quantity, unit_cost) VALUES (?,?,?,?,?)', [voucherId, i + 1, p.id, l.quantity, type === 'entry' ? (l.unitCost ?? null) : null]);
    }
  }

  router.get(['/', '/export'], requirePermission('stock.read'), validate({ query: listQuerySchema.omit({ status: true }).extend({ ...rangeShape, status: z.enum(['draft', 'validated', 'cancelled']).optional() }) }), asyncHandler(async (req, res) => {
    await withTransaction((c) => ensureDefaultWarehouse(c, req.auth.companyId, req.auth.userId));
    const q = req.query; const where = ['v.company_id = ?', 'v.type = ?']; const params = [req.auth.companyId, type];
    if (q.status) { where.push('v.status = ?'); params.push(q.status); }
    applyAdvanced({ q, where, params, auth: req.auth }, { alias: 'v', dateCol: 'voucher_date', partyCols: ['v.number', 'v.reason'], notesCol: 'notes', linesTable: 'stock_voucher_lines', linesFk: 'voucher_id', linesHaveDescription: false });
    const from = 'FROM stock_vouchers v JOIN warehouses w ON w.id = v.warehouse_id LEFT JOIN warehouses t ON t.id = v.to_warehouse_id';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
    const [rows] = await pool.query(`SELECT v.public_id, v.number, v.status, v.reason, DATE_FORMAT(v.voucher_date,'%Y-%m-%d') AS d, w.name AS wh, t.name AS to_name, (SELECT COUNT(*) FROM stock_voucher_lines l WHERE l.voucher_id = v.id) AS n ${from} WHERE ${where.join(' AND ')} ORDER BY v.voucher_date DESC, v.id DESC LIMIT ? OFFSET ?`, [...params, pageOf(req).limit, pageOf(req).offset]);
    if (isExport(req)) return exportCsv(req, res, { rows, total, file: `${type}.csv`, action: 'stock_voucher.export', entity: 'stock_vouchers', headers: ['N°', 'Statut', 'Date', 'Entrepôt', 'Destination', 'Motif', 'Lignes'], row: (r) => [r.number ?? '', ({ draft: 'Brouillon', validated: 'Validé', cancelled: 'Annulé' })[r.status] ?? r.status, csvDate(r.d), r.wh, r.to_name ?? '', r.reason ?? '', r.n] });
    res.json({ data: rows.map((r) => ({ id: r.public_id, number: r.number, status: r.status, date: r.d, warehouse: r.wh, toWarehouse: r.to_name, reason: r.reason, lineCount: Number(r.n) })), meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) } });
  }));
  router.get('/:id', requirePermission('stock.read'), validate({ params: idParam }), asyncHandler(async (req, res) => { res.json({ data: await dto(pool, req.auth.companyId, req.params.id) }); }));
  router.get('/:id/pdf', requirePermission('stock.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const d = await dto(pool, req.auth.companyId, req.params.id);
    const buf = await renderStockVoucherPdf({ doc: d, companyId: req.auth.companyId });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileSafe(d.number ?? `${T.prefix}-brouillon`)}.pdf"` }).send(buf);
  }));
  router.get('/:id/history', requirePermission('stock.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await find(pool, req.auth.companyId, req.params.id); res.json({ data: await history(req.auth.companyId, 'stock_vouchers', req.params.id) });
  }));

  router.post('/', requirePermission('stock.write'), validate({ body }), asyncHandler(async (req, res) => {
    const publicId = newPublicId();
    await withTransaction(async (conn) => {
      const wh = await findWarehouse(conn, req.auth.companyId, req.body.warehouseId);
      const to = type === 'transfer' ? await findWarehouse(conn, req.auth.companyId, req.body.toWarehouseId) : null;
      const [r] = await conn.query('INSERT INTO stock_vouchers (public_id, company_id, type, status, warehouse_id, to_warehouse_id, voucher_date, reason, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [publicId, req.auth.companyId, type, 'draft', wh.id, to?.id ?? null, req.body.date, req.body.reason ?? null, req.body.notes ?? null, req.auth.userId]);
      await writeLines(conn, r.insertId, req.auth.companyId, req.body.lines);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${T.action}.create`, entityType: 'stock_vouchers', entityId: publicId, ip: req.ip });
    });
    res.status(201).json({ data: await dto(pool, req.auth.companyId, publicId) });
  }));

  router.put('/:id', requirePermission('stock.write'), validate({ params: idParam, body }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await find(conn, req.auth.companyId, req.params.id, true);
      if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Un bon validé ne se modifie pas : annulez-le et recréez-le');
      const wh = await findWarehouse(conn, req.auth.companyId, req.body.warehouseId);
      const to = type === 'transfer' ? await findWarehouse(conn, req.auth.companyId, req.body.toWarehouseId) : null;
      await conn.query('UPDATE stock_vouchers SET warehouse_id = ?, to_warehouse_id = ?, voucher_date = ?, reason = ?, notes = ? WHERE id = ?', [wh.id, to?.id ?? null, req.body.date, req.body.reason ?? null, req.body.notes ?? null, cur.id]);
      await writeLines(conn, cur.id, req.auth.companyId, req.body.lines);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${T.action}.update`, entityType: 'stock_vouchers', entityId: cur.public_id, ip: req.ip });
    });
    res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
  }));

  router.delete('/:id', requirePermission('stock.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await find(conn, req.auth.companyId, req.params.id, true);
      if (cur.status !== 'draft') throw new HttpError(409, 'DOCUMENT_LOCKED', 'Seul un brouillon peut être supprimé ; un bon validé s\'annule');
      await conn.query('DELETE FROM stock_vouchers WHERE id = ?', [cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${T.action}.delete`, entityType: 'stock_vouchers', entityId: cur.public_id, ip: req.ip });
    });
    res.status(204).end();
  }));

  router.post('/:id/validate', requirePermission('stock.validate'), validate({ params: idParam }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await find(conn, req.auth.companyId, req.params.id, true);
      if (cur.status !== 'draft') throw new HttpError(409, 'INVALID_TRANSITION', 'Ce bon est déjà validé ou annulé');
      if (cur.date_s > todayTunis()) throw new HttpError(422, 'FUTURE_DATE', 'La date du bon est dans le futur');
      const [wh] = [await findWarehouse(conn, req.auth.companyId, cur.wh_pid)];
      const to = cur.to_pid ? await findWarehouse(conn, req.auth.companyId, cur.to_pid) : null;
      const [lines] = await conn.query('SELECT l.*, p.purchase_price FROM stock_voucher_lines l JOIN products p ON p.id = l.product_id WHERE l.voucher_id = ? ORDER BY l.position', [cur.id]);
      if (!lines.length) throw new HttpError(422, 'EMPTY_DOCUMENT', 'Aucune ligne');
      const series = cur.date_s.slice(0, 4);
      const number = await nextDocNumber(conn, req.auth.companyId, `stock_${type}`, series);
      const src = (l) => ({ type: `stock_${type}`, id: cur.public_id, number, lineId: l.id });
      const items = [];
      for (const l of lines) {
        const base = { productId: l.product_id, warehouseId: wh.id, date: cur.date_s, reason: cur.reason, source: src(l) };
        if (type === 'entry') {
          const [[ps]] = await conn.query('SELECT quantity, avg_cost FROM product_stock WHERE product_id = ?', [l.product_id]);
          const cost = l.unit_cost ?? (ps && Number(ps.quantity) > 0 ? ps.avg_cost : l.purchase_price ? `${l.purchase_price}0` : null);
          if (cost === null) throw new HttpError(422, 'COST_REQUIRED', 'Coût unitaire requis (aucun prix d\'achat ni coût moyen connu pour un article)');
          items.push({ ...base, kind: 'entry', quantity: l.quantity, unitCost: cost });
        } else if (type === 'withdrawal') items.push({ ...base, kind: 'withdrawal', quantity: `-${l.quantity}` });
        else { items.push({ ...base, kind: 'transfer_out', quantity: `-${l.quantity}` }, { ...base, warehouseId: to.id, kind: 'transfer_in', quantity: l.quantity }); }
      }
      await moveStock(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, items);
      await conn.query("UPDATE stock_vouchers SET status = 'validated', number = ?, series = ?, validated_at = UTC_TIMESTAMP(), validated_by = ? WHERE id = ?", [number, series, req.auth.userId, cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${T.action}.validate`, entityType: 'stock_vouchers', entityId: cur.public_id, ip: req.ip, meta: { number } });
    });
    res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
  }));

  router.post('/:id/cancel', requirePermission('stock.validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5, 'Motif requis (5 caractères minimum)').max(255) }) }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const cur = await find(conn, req.auth.companyId, req.params.id, true);
      if (cur.status !== 'validated') throw new HttpError(409, 'INVALID_TRANSITION', 'Seul un bon validé peut être annulé (un brouillon se supprime)');
      await reverseSource(conn, { companyId: req.auth.companyId, userId: req.auth.userId }, {
        companyId: req.auth.companyId, type: `stock_${type}`, id: cur.public_id, number: cur.number, kinds: type === 'transfer' ? ['transfer_in', 'transfer_out'] : [type === 'entry' ? 'entry' : 'withdrawal'],
        reverseKind: 'cancellation', date: todayTunis(), reason: `Annulation ${cur.number} : ${req.body.reason}`.slice(0, 255),
      });
      await conn.query("UPDATE stock_vouchers SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [req.body.reason, cur.id]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${T.action}.cancel`, entityType: 'stock_vouchers', entityId: cur.public_id, ip: req.ip, meta: { number: cur.number, reason: req.body.reason } });
    });
    res.json({ data: await dto(pool, req.auth.companyId, req.params.id) });
  }));

  return router;
}
