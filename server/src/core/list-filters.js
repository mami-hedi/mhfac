// Filtres avancés communs aux listes de documents (panneau « Filtres » de l'interface) et export CSV de la liste filtrée.
// Tout est paramétré (jamais de valeur du client dans le SQL) et limité à l'entreprise de la session (projet et produit inconnus = aucun résultat).
import { z } from 'zod';
import { HttpError } from '../utils/httpError.js';
import { EXPORT_MAX, escapeLike } from './list.js';
import { audit } from './audit.js';
import { toCsv } from './csv.js';
import { iso as isoDate } from '../modules/stock/schemas.js';

const money = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/, 'Montant invalide (ex. 1250.500)');
export const advancedShape = { minAmount: money.optional(), maxAmount: money.optional(), projectId: z.string().uuid().optional(), productId: z.string().uuid().optional() };

// cfg : { alias, dateCol, totalCol, partyCols[], notesCol, linesTable, linesFk, hasProject }
export function applyAdvanced({ q, where, params, auth }, cfg) {
  const a = cfg.alias;
  if (q.from) { where.push(`${a}.${cfg.dateCol} >= ?`); params.push(q.from); }
  if (q.to) { where.push(`${a}.${cfg.dateCol} <= ?`); params.push(q.to); }
  if (q.from && q.to && q.from > q.to) throw new HttpError(422, 'VALIDATION_ERROR', 'La date de début est postérieure à la date de fin');
  if (q.minAmount && q.maxAmount && Number(q.minAmount) > Number(q.maxAmount)) throw new HttpError(422, 'VALIDATION_ERROR', 'Le montant minimum dépasse le montant maximum');
  if (q.minAmount && cfg.totalCol) { where.push(`${a}.${cfg.totalCol} >= CAST(? AS DECIMAL(15,3))`); params.push(q.minAmount); }
  if (q.maxAmount && cfg.totalCol) { where.push(`${a}.${cfg.totalCol} <= CAST(? AS DECIMAL(15,3))`); params.push(q.maxAmount); }
  if (q.projectId && cfg.hasProject) { where.push(`${a}.project_id = (SELECT id FROM projects WHERE company_id = ? AND public_id = ?)`); params.push(auth.companyId, q.projectId); }
  if (q.productId && cfg.linesTable && cfg.linesHaveProduct !== false) {
    where.push(`EXISTS (SELECT 1 FROM ${cfg.linesTable} fl WHERE fl.${cfg.linesFk} = ${a}.id AND ${cfg.orderLinesTable ? `COALESCE(fl.product_id, (SELECT ol.product_id FROM ${cfg.orderLinesTable} ol WHERE ol.id = fl.order_line_id))` : 'fl.product_id'} = (SELECT id FROM products WHERE company_id = ? AND public_id = ?))`);
    params.push(auth.companyId, q.productId);
  }
  if (q.q) { // recherche avancée : numéro, tiers, référence, notes ET désignations des lignes
    const like = `%${escapeLike(q.q)}%`;
    const cols = [...cfg.partyCols, ...(cfg.notesCol ? [`${a}.${cfg.notesCol}`] : [])];
    const withLines = cfg.linesTable && cfg.linesHaveDescription !== false;
    where.push(`(${cols.map((c) => `${c} LIKE ?`).join(' OR ')}${withLines ? ` OR EXISTS (SELECT 1 FROM ${cfg.linesTable} sl WHERE sl.${cfg.linesFk} = ${a}.id AND sl.description LIKE ?)` : ''})`);
    params.push(...cols.map(() => like), ...(withLines ? [like] : []));
  }
}

export const meta = (q, total) => ({ page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) });

// Montant au format Excel français : virgule décimale (« 1250,500 »)
export const csvMoney = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
export const csvDate = (v) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '');
export function sendCsv(res, filename, text, { total, shown }) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'X-Total-Count': String(total), 'X-Export-Truncated': shown < total ? '1' : '0', 'Access-Control-Expose-Headers': 'X-Total-Count, X-Export-Truncated, Content-Disposition' });
  res.send(text);
}

// Plage de dates + filtres avancés, à ajouter au schéma de requête d'une liste.
export const rangeShape = { from: isoDate.optional(), to: isoDate.optional(), ...advancedShape };
export const isExport = (req) => req.path === '/export';
// Pagination (15 par défaut) ; en mode export : tout, plafonné.
export const pageOf = (req) => (isExport(req) ? { limit: EXPORT_MAX, offset: 0 } : { limit: req.query.limit, offset: (req.query.page - 1) * req.query.limit });
// Export CSV d'une liste à partir des lignes SQL brutes déjà filtrées (mêmes filtres que l'écran), journalisé.
export async function exportCsv(req, res, { rows, total, file, action, entity, headers, row }) {
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action, entityType: entity, ip: req.ip, meta: { rows: rows.length, total } });
  sendCsv(res, file, toCsv(headers, rows.map(row)), { total, shown: rows.length });
}
export const parseSnap = (v) => (typeof v === 'string' ? JSON.parse(v) : v) ?? {};
