import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate, asPatch } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { nextNumber, formatCode } from '../../core/numbering.js';
import { decimalField } from '../../core/money.js';
import { resolveRef } from '../../core/refs.js';
import { listQuerySchema, escapeLike, orderBy } from '../../core/list.js';
import { parseCsv, toCsv } from '../../core/csv.js';

const opt = (schema) => z.preprocess((v) => (v === '' || v === undefined ? null : v), schema.nullable());
const fields = {
  sku: opt(z.string().trim().max(60).regex(/^[A-Za-z0-9._\/-]+$/, 'SKU : lettres, chiffres, . _ / - uniquement')),
  barcode: opt(z.string().trim().max(60).regex(/^[0-9A-Za-z-]+$/, 'Code-barres invalide')),
  name: z.string().trim().min(2, 'Nom trop court').max(190),
  description: opt(z.string().trim().max(5000)),
  type: z.enum(['product', 'service']).default('product'),
  categoryId: opt(z.string().uuid()),
  salePrice: decimalField().default('0.000'),
  purchasePrice: opt(decimalField()),
  unit: z.string().trim().min(1).max(20).default('unité'),
  taxRateId: opt(z.string().uuid()),
  trackStock: z.boolean().default(false),
  fodecSubject: z.boolean().default(false),
  stockAlertThreshold: opt(decimalField({ scale: 4 })),
};
const createSchema = z.object(fields);
const updateSchema = asPatch(z.object(fields).partial().extend({ status: z.enum(['active', 'archived']).optional() }).refine((o) => Object.values(o).some((x) => x !== undefined), 'Aucune modification'));
const idParam = z.object({ id: z.string().uuid() });
const SORT = { id: 'p.id', sku: 'p.sku', name: 'p.name', price: 'p.sale_price', created: 'p.created_at' };

const SELECT = `SELECT p.*, c.public_id AS cat_pid, c.name AS cat_name, t.public_id AS tax_pid, t.name AS tax_name, t.rate AS tax_rate, t.kind AS tax_kind
  FROM products p LEFT JOIN product_categories c ON c.id = p.category_id LEFT JOIN tax_rates t ON t.id = p.tax_rate_id`;
const dto = (r) => ({
  id: r.public_id, sku: r.sku, barcode: r.barcode, name: r.name, description: r.description, type: r.type,
  category: r.cat_pid ? { id: r.cat_pid, name: r.cat_name } : null,
  salePrice: r.sale_price, purchasePrice: r.purchase_price, unit: r.unit,
  taxRate: r.tax_pid ? { id: r.tax_pid, name: r.tax_name, rate: r.tax_rate, kind: r.tax_kind } : null,
  trackStock: !!r.track_stock, fodecSubject: !!r.fodec_subject, stockAlertThreshold: r.stock_alert_threshold, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});

const router = Router();
router.use(authenticate);

async function findOne(conn, companyId, publicId) {
  const [[row]] = await conn.query(`${SELECT} WHERE p.company_id = ? AND p.public_id = ?`, [companyId, publicId]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Article introuvable');
  return row;
}

async function resolveTax(conn, companyId, publicId, { requireActive }) {
  if (publicId) {
    const [[t]] = await conn.query('SELECT id, is_active FROM tax_rates WHERE company_id = ? AND public_id = ?', [companyId, publicId]);
    if (!t) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Taux de TVA introuvable');
    if (requireActive && !t.is_active) throw new HttpError(422, 'INACTIVE_TAX_RATE', 'Ce taux de TVA est désactivé');
    return t.id;
  }
  const [[d]] = await conn.query('SELECT id FROM tax_rates WHERE company_id = ? AND is_default = 1 AND is_active = 1', [companyId]);
  if (!d) throw new HttpError(422, 'NO_DEFAULT_TAX', 'Aucun taux de TVA par défaut : configurez-en un dans Paramètres');
  return d.id;
}

async function assertUnique(conn, companyId, col, value, exceptId, msg) {
  if (!value) return;
  const [[d]] = await conn.query(`SELECT id FROM products WHERE company_id = ? AND ${col} = ? AND (? IS NULL OR id <> ?) LIMIT 1`, [companyId, value, exceptId, exceptId]);
  if (d) throw new HttpError(409, 'DUPLICATE', msg);
}

function normalizeRules(d) {
  if (d.type === 'service') { d.trackStock = false; d.stockAlertThreshold = null; }
  if (!d.trackStock) d.stockAlertThreshold = null;
}

async function insertOne(conn, auth, d, ip) {
  normalizeRules(d);
  const sku = d.sku ?? formatCode('ART', await nextNumber(conn, auth.companyId, 'products_sku'));
  await assertUnique(conn, auth.companyId, 'sku', sku, null, 'Ce SKU existe déjà');
  await assertUnique(conn, auth.companyId, 'barcode', d.barcode, null, 'Ce code-barres existe déjà');
  const categoryId = await resolveRef(conn, 'product_categories', auth.companyId, d.categoryId ?? null, 'Catégorie');
  const taxId = await resolveTax(conn, auth.companyId, d.taxRateId, { requireActive: true });
  const publicId = newPublicId();
  await conn.query(
    `INSERT INTO products (public_id, company_id, sku, barcode, name, description, type, category_id, sale_price, purchase_price, unit, tax_rate_id, track_stock, stock_alert_threshold, created_by, fodec_subject)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [publicId, auth.companyId, sku, d.barcode ?? null, d.name, d.description ?? null, d.type, categoryId, d.salePrice, d.purchasePrice ?? null, d.unit, taxId, d.trackStock ? 1 : 0, d.stockAlertThreshold ?? null, auth.userId, d.type === 'service' ? 0 : (d.fodecSubject ? 1 : 0)],
  );
  await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'product.create', entityType: 'products', entityId: publicId, ip, meta: { sku } });
  return publicId;
}

function buildWhere(auth, q) {
  const where = ['p.company_id = ?']; const params = [auth.companyId];
  if (q.status) { where.push('p.status = ?'); params.push(q.status); }
  if (q.type) { where.push('p.type = ?'); params.push(q.type); }
  if (q.categoryId) { where.push('c.public_id = ?'); params.push(q.categoryId); }
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)'); params.push(like, like, like);
  }
  return { sql: where.join(' AND '), params };
}
const productListQuery = listQuerySchema.extend({ type: z.enum(['product', 'service']).optional(), categoryId: z.string().uuid().optional() });

router.get('/', requirePermission('product.read'), validate({ query: productListQuery }), asyncHandler(async (req, res) => {
  const { sql, params } = buildWhere(req.auth, req.query);
  const { page, limit } = req.query;
  const from = 'FROM products p LEFT JOIN product_categories c ON c.id = p.category_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${sql}`, params);
  const [rows] = await pool.query(`${SELECT} WHERE ${sql} ORDER BY ${orderBy(req.query.sort, req.query.order, SORT, 'name')} LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
  res.json({ data: rows.map(dto), meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
}));

router.get('/export.csv', requirePermission('product.read'), validate({ query: productListQuery.pick({ q: true, status: true, type: true, categoryId: true }) }), asyncHandler(async (req, res) => {
  const { sql, params } = buildWhere(req.auth, req.query);
  const [rows] = await pool.query(`${SELECT} WHERE ${sql} ORDER BY p.name ASC, p.id ASC LIMIT 10000`, params);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'product.export', entityType: 'products', ip: req.ip, meta: { rows: rows.length } });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="articles.csv"' });
  res.send(toCsv(['SKU', 'Code-barres', 'Nom', 'Description', 'Type', 'Catégorie', 'Prix de vente HT', "Prix d'achat HT", 'Unité', 'TVA', 'Suivi de stock', "Seuil d'alerte", 'Statut'],
    rows.map((r) => [r.sku, r.barcode, r.name, r.description, r.type === 'service' ? 'service' : 'produit', r.cat_name, r.sale_price, r.purchase_price, r.unit, r.tax_name, r.track_stock ? 'oui' : 'non', r.stock_alert_threshold, r.status === 'active' ? 'actif' : 'archivé'])));
}));

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = { sku: ['sku', 'reference', 'ref'], barcode: ['codebarres', 'codebarre', 'barcode', 'ean'], name: ['nom', 'name', 'designation'], description: ['description'], type: ['type'], category: ['categorie', 'category'],
  salePrice: ['prixdeventeht', 'prixventeht', 'prixvente', 'saleprice'], purchasePrice: ['prixdachatht', 'prixachatht', 'prixachat', 'purchaseprice'], unit: ['unite', 'unit'], tax: ['tva', 'taxe', 'tax'], trackStock: ['suividestock', 'trackstock', 'stock'], threshold: ['seuildalerte', 'seuil'] };
const YES = new Set(['oui', 'yes', '1', 'true', 'x']);

const importSchema = z.object({ csv: z.string().min(1).max(900_000), dryRun: z.boolean().default(false), skipInvalid: z.boolean().default(false) });
router.post('/import', requirePermission('product.write'), validate({ body: importSchema }), asyncHandler(async (req, res) => {
  let parsed;
  try { parsed = parseCsv(req.body.csv); } catch (e) { throw new HttpError(400, 'INVALID_CSV', e.message); }
  if (!parsed.rows.length) throw new HttpError(400, 'INVALID_CSV', 'Aucune ligne de données');
  if (parsed.rows.length > 1000) throw new HttpError(400, 'TOO_MANY_ROWS', 'Maximum 1000 lignes par import');
  const map = {};
  parsed.headers.forEach((h, i) => { const f = Object.keys(ALIASES).find((k) => ALIASES[k].includes(norm(h))); if (f && !(f in map)) map[f] = i; });
  if (!('name' in map)) throw new HttpError(400, 'INVALID_CSV', 'Colonne « Nom » obligatoire');

  const [cats] = await pool.query('SELECT public_id, name FROM product_categories WHERE company_id = ?', [req.auth.companyId]);
  const [taxes] = await pool.query('SELECT public_id, name, rate, is_active FROM tax_rates WHERE company_id = ?', [req.auth.companyId]);
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.public_id]));
  const valid = []; const errors = []; const seen = new Set();
  parsed.rows.forEach((cells, idx) => {
    const line = idx + 2; const g = (k) => (k in map ? (cells[map[k]] ?? '').trim() : '');
    const issues = []; const raw = { sku: g('sku'), barcode: g('barcode'), name: g('name'), description: g('description'), unit: g('unit') || undefined, salePrice: g('salePrice') || '0', purchasePrice: g('purchasePrice'), stockAlertThreshold: g('threshold') };
    raw.type = ['service', 'services'].includes(norm(g('type'))) ? 'service' : 'product';
    raw.trackStock = YES.has(g('trackStock').toLowerCase());
    const tx = g('tax');
    if (tx) {
      const t = taxes.find((x) => x.name.toLowerCase() === tx.toLowerCase() || Number(x.rate) === Number(tx.replace('%', '').replace(',', '.')));
      if (!t) issues.push(`TVA « ${tx} » inconnue`); else if (!t.is_active) issues.push(`TVA « ${tx} » désactivée`); else raw.taxRateId = t.public_id;
    }
    const r = createSchema.safeParse(raw);
    if (!r.success) issues.push(...r.error.issues.map((i) => `${i.path[0]} : ${i.message}`));
    for (const key of [r.data?.sku && `sku:${r.data.sku}`, r.data?.barcode && `bc:${r.data.barcode}`]) {
      if (key) { if (seen.has(key)) issues.push('SKU ou code-barres en double dans le fichier'); seen.add(key); }
    }
    if (issues.length) errors.push({ line, message: issues.join(' ; ') }); else valid.push({ line, data: r.data, category: g('category') });
  });
  const result = { total: parsed.rows.length, valid: valid.length, errors, created: 0, dryRun: req.body.dryRun };
  if (req.body.dryRun) return res.json({ data: result });
  if (errors.length && !req.body.skipInvalid) return res.status(422).json({ error: { code: 'IMPORT_HAS_ERRORS', message: 'Corrigez les lignes en erreur ou importez uniquement les lignes valides', details: result } });

  await withTransaction(async (conn) => {
    for (const v of valid) {
      try {
        if (v.category) {
          let pid = catByName.get(v.category.toLowerCase());
          if (!pid) { pid = newPublicId(); await conn.query('INSERT INTO product_categories (public_id, company_id, name) VALUES (?,?,?)', [pid, req.auth.companyId, v.category.slice(0, 100)]); catByName.set(v.category.toLowerCase(), pid); }
          v.data.categoryId = pid;
        }
        await insertOne(conn, req.auth, v.data, req.ip); result.created++;
      } catch (e) { if (e instanceof HttpError && ['DUPLICATE', 'UNKNOWN_REFERENCE'].includes(e.code)) errors.push({ line: v.line, message: e.message }); else throw e; }
    }
    if (errors.length && !req.body.skipInvalid) throw new HttpError(422, 'IMPORT_HAS_ERRORS', 'Import annulé : lignes en doublon', { ...result, created: 0 });
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'product.import', entityType: 'products', ip: req.ip, meta: { created: result.created, rejected: errors.length } });
  });
  res.status(201).json({ data: result });
}));

router.post('/', requirePermission('product.write'), validate({ body: createSchema }), asyncHandler(async (req, res) => {
  const publicId = await withTransaction((conn) => insertOne(conn, req.auth, req.body, req.ip));
  res.status(201).json({ data: dto(await findOne(pool, req.auth.companyId, publicId)) });
}));

router.get('/:id', requirePermission('product.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  res.json({ data: dto(await findOne(pool, req.auth.companyId, req.params.id)) });
}));

router.patch('/:id', requirePermission('product.write'), validate({ params: idParam, body: updateSchema }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const cur = await findOne(conn, req.auth.companyId, req.params.id);
    const b = req.body; const set = {};
    if ('sku' in b) { if (!b.sku) throw new HttpError(422, 'INVALID', 'SKU obligatoire'); await assertUnique(conn, req.auth.companyId, 'sku', b.sku, cur.id, 'Ce SKU existe déjà'); set.sku = b.sku; }
    if ('barcode' in b) { await assertUnique(conn, req.auth.companyId, 'barcode', b.barcode, cur.id, 'Ce code-barres existe déjà'); set.barcode = b.barcode; }
    for (const [k, c] of [['name', 'name'], ['description', 'description'], ['salePrice', 'sale_price'], ['purchasePrice', 'purchase_price'], ['unit', 'unit'], ['status', 'status']]) if (k in b) set[c] = b[k];
    if ('salePrice' in b && b.salePrice === null) throw new HttpError(422, 'INVALID', 'Prix de vente obligatoire');
    if ('categoryId' in b) set.category_id = await resolveRef(conn, 'product_categories', req.auth.companyId, b.categoryId, 'Catégorie');
    if ('taxRateId' in b) {
      if (!b.taxRateId) throw new HttpError(422, 'INVALID', 'Taux de TVA obligatoire');
      const [[same]] = await conn.query('SELECT 1 AS ok FROM tax_rates WHERE id = ? AND public_id = ?', [cur.tax_rate_id, b.taxRateId]);
      set.tax_rate_id = await resolveTax(conn, req.auth.companyId, b.taxRateId, { requireActive: !same });
    }
    const eff = { type: b.type ?? cur.type, trackStock: 'trackStock' in b ? b.trackStock : !!cur.track_stock, stockAlertThreshold: 'stockAlertThreshold' in b ? b.stockAlertThreshold : cur.stock_alert_threshold };
    normalizeRules(eff);
    if (cur.track_stock && !eff.trackStock) {
      const [[st]] = await conn.query('SELECT quantity FROM product_stock WHERE product_id = ?', [cur.id]);
      if (st && Number(st.quantity) !== 0) throw new HttpError(409, 'HAS_STOCK', 'Cet article a du stock : videz-le (sortie ou inventaire) avant de désactiver le suivi de stock');
    }
    if ('type' in b || 'trackStock' in b || 'stockAlertThreshold' in b) { set.type = eff.type; set.track_stock = eff.trackStock ? 1 : 0; set.stock_alert_threshold = eff.stockAlertThreshold; }
    if ('fodecSubject' in b) set.fodec_subject = (b.type ?? cur.type) === 'service' ? 0 : (b.fodecSubject ? 1 : 0);
    const entries = Object.entries(set);
    if (entries.length) await conn.query(`UPDATE products SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ? AND company_id = ?`, [...entries.map(([, v]) => v), cur.id, req.auth.companyId]);
    const action = b.status && b.status !== cur.status ? (b.status === 'archived' ? 'archive' : 'restore') : 'update';
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `product.${action}`, entityType: 'products', entityId: cur.public_id, ip: req.ip, meta: { fields: Object.keys(b), previousSalePrice: 'salePrice' in b ? cur.sale_price : undefined } });
  });
  res.json({ data: dto(await findOne(pool, req.auth.companyId, req.params.id)) });
}));

router.delete('/:id', requirePermission('product.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const row = await findOne(pool, req.auth.companyId, req.params.id);
  await pool.query('DELETE FROM products WHERE id = ? AND company_id = ?', [row.id, req.auth.companyId]);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'product.delete', entityType: 'products', entityId: row.public_id, ip: req.ip, meta: { sku: row.sku } });
  res.status(204).end();
}));

export default router;
