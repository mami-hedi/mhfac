// Fabrique commune clients / fournisseurs : memes champs, memes regles, tables et permissions distinctes.
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
import { listQuerySchema, escapeLike, orderBy } from '../../core/list.js';
import { parseCsv, toCsv } from '../../core/csv.js';

const opt = (schema) => z.preprocess((v) => (v === '' || v === undefined ? null : v), schema.nullable());
const text = (max) => opt(z.string().trim().max(max));

const fields = {
  name: z.string().trim().min(2, 'Nom trop court').max(190),
  type: z.enum(['individual', 'company']).default('company'),
  taxId: opt(z.string().trim().max(50).regex(/^[A-Za-z0-9\/ .-]+$/, 'Caractères non autorisés')),
  tradeRegister: text(60),
  address: text(255),
  governorate: text(100),
  postalCode: text(20),
  phone: opt(z.string().trim().max(40).regex(/^[0-9+()\s.-]{4,}$/, 'Téléphone invalide')),
  email: opt(z.string().trim().toLowerCase().email('E-mail invalide').max(190)),
  country: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{2}$/, 'Code pays ISO à 2 lettres')).default('TN'),
  currency: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{3}$/, 'Code devise ISO à 3 lettres')).default('TND'),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(0),
  notes: opt(z.string().trim().max(5000)),
};
const createSchema = z.object(fields);
const updateSchema = asPatch(z.object(fields).partial().extend({ status: z.enum(['active', 'archived']).optional() })
  .refine((o) => Object.values(o).some((x) => x !== undefined), 'Aucune modification'));

const COLS = { name: 'name', type: 'type', taxId: 'tax_id', tradeRegister: 'trade_register', address: 'address', governorate: 'governorate', postalCode: 'postal_code', phone: 'phone', email: 'email', country: 'country', currency: 'currency', paymentTermsDays: 'payment_terms_days', notes: 'notes' };

const dto = (r) => ({
  id: r.public_id, code: r.code, name: r.name, type: r.type, taxId: r.tax_id, tradeRegister: r.trade_register,
  address: r.address, governorate: r.governorate, postalCode: r.postal_code, phone: r.phone, email: r.email,
  country: r.country, currency: r.currency, paymentTermsDays: r.payment_terms_days, notes: r.notes,
  status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});

// En-tetes CSV acceptes (FR/EN, insensibles a la casse et aux accents) -> champ interne
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_ALIASES = {
  name: ['nom', 'name', 'raisonsociale', 'designation'], type: ['type'], taxId: ['matriculefiscal', 'mf', 'taxid'],
  tradeRegister: ['registrecommerce', 'rc', 'traderegister'], address: ['adresse', 'address'], governorate: ['gouvernorat', 'governorate'],
  postalCode: ['codepostal', 'postalcode'], phone: ['telephone', 'tel', 'phone'], email: ['email', 'courriel', 'mail'],
  country: ['pays', 'country'], currency: ['devise', 'currency'], paymentTermsDays: ['delaipaiement', 'delaipaiementjours', 'paymenttermsdays'], notes: ['notes', 'note'],
};
const TYPE_ALIASES = { particulier: 'individual', individual: 'individual', entreprise: 'company', societe: 'company', company: 'company' };
const EXPORT_HEADERS = ['Code', 'Nom', 'Type', 'Matricule fiscal', 'Registre de commerce', 'Adresse', 'Gouvernorat', 'Code postal', 'Téléphone', 'E-mail', 'Pays', 'Devise', 'Délai de paiement (jours)', 'Statut'];

export function makePartiesModule({ table, perm, prefix, label, auditPrefix }) {
  const router = Router();
  router.use(authenticate);
  const SORT = { id: 'id', code: 'code', name: 'name', created: 'created_at' };
  const idParam = z.object({ id: z.string().uuid() });

  async function findOne(conn, companyId, publicId) {
    const [[row]] = await conn.query(`SELECT * FROM ${table} WHERE company_id = ? AND public_id = ?`, [companyId, publicId]);
    if (!row) throw new HttpError(404, 'NOT_FOUND', `${label} introuvable`);
    return row;
  }

  async function assertTaxIdFree(conn, companyId, taxId, exceptId = null) {
    if (!taxId) return;
    const [[dup]] = await conn.query(`SELECT code FROM ${table} WHERE company_id = ? AND tax_id = ? AND (? IS NULL OR id <> ?) LIMIT 1`, [companyId, taxId, exceptId, exceptId]);
    if (dup) throw new HttpError(409, 'DUPLICATE_TAX_ID', `Ce matricule fiscal est déjà utilisé (${dup.code})`);
  }

  async function insertOne(conn, auth, data, ip) {
    await assertTaxIdFree(conn, auth.companyId, data.taxId);
    const code = formatCode(prefix, await nextNumber(conn, auth.companyId, table));
    const publicId = newPublicId();
    const keys = Object.keys(COLS);
    await conn.query(
      `INSERT INTO ${table} (public_id, company_id, code, ${keys.map((k) => COLS[k]).join(',')}, created_by) VALUES (?,?,?,${keys.map(() => '?').join(',')},?)`,
      [publicId, auth.companyId, code, ...keys.map((k) => data[k] ?? null), auth.userId],
    );
    await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: `${auditPrefix}.create`, entityType: table, entityId: publicId, ip, meta: { code } });
    return publicId;
  }

  function buildWhere(auth, q) {
    const where = ['company_id = ?']; const params = [auth.companyId];
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      where.push('(name LIKE ? OR code LIKE ? OR tax_id LIKE ? OR email LIKE ? OR phone LIKE ?)');
      params.push(like, like, like, like, like);
    }
    return { sql: where.join(' AND '), params };
  }

  router.get('/', requirePermission(`${perm}.read`), validate({ query: listQuerySchema }), asyncHandler(async (req, res) => {
    const { sql, params } = buildWhere(req.auth, req.query);
    const { page, limit } = req.query;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table} WHERE ${sql}`, params);
    const [rows] = await pool.query(`SELECT * FROM ${table} WHERE ${sql} ORDER BY ${orderBy(req.query.sort, req.query.order, SORT, 'name')} LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ data: rows.map(dto), meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  }));

  // Export controle : meme permission de lecture + journalise, filtres identiques a la liste, plafond de lignes.
  router.get('/export.csv', requirePermission(`${perm}.read`), validate({ query: listQuerySchema.pick({ q: true, status: true }) }), asyncHandler(async (req, res) => {
    const { sql, params } = buildWhere(req.auth, req.query);
    const [rows] = await pool.query(`SELECT * FROM ${table} WHERE ${sql} ORDER BY name ASC, id ASC LIMIT 10000`, params);
    await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${auditPrefix}.export`, entityType: table, ip: req.ip, meta: { rows: rows.length } });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${table}.csv"` });
    res.send(toCsv(EXPORT_HEADERS, rows.map((r) => [r.code, r.name, r.type === 'individual' ? 'particulier' : 'entreprise', r.tax_id, r.trade_register, r.address, r.governorate, r.postal_code, r.phone, r.email, r.country, r.currency, r.payment_terms_days, r.status === 'active' ? 'actif' : 'archivé'])));
  }));

  const importSchema = z.object({ csv: z.string().min(1).max(900_000), dryRun: z.boolean().default(false), skipInvalid: z.boolean().default(false) });
  router.post('/import', requirePermission(`${perm}.write`), validate({ body: importSchema }), asyncHandler(async (req, res) => {
    let parsed;
    try { parsed = parseCsv(req.body.csv); } catch (e) { throw new HttpError(400, 'INVALID_CSV', e.message); }
    if (parsed.rows.length === 0) throw new HttpError(400, 'INVALID_CSV', 'Aucune ligne de données');
    if (parsed.rows.length > 1000) throw new HttpError(400, 'TOO_MANY_ROWS', 'Maximum 1000 lignes par import');
    const map = {};
    parsed.headers.forEach((h, i) => { const n = norm(h); const f = Object.keys(HEADER_ALIASES).find((k) => HEADER_ALIASES[k].includes(n)); if (f && !(f in map)) map[f] = i; });
    if (!('name' in map)) throw new HttpError(400, 'INVALID_CSV', 'Colonne « Nom » obligatoire');

    const valid = []; const errors = []; const seenTax = new Set();
    parsed.rows.forEach((cells, idx) => {
      const line = idx + 2;
      const raw = {};
      for (const [f, i] of Object.entries(map)) raw[f] = (cells[i] ?? '').trim();
      if (raw.type) raw.type = TYPE_ALIASES[norm(raw.type)] ?? raw.type;
      for (const k of ['type', 'country', 'currency', 'paymentTermsDays']) if (raw[k] === '') delete raw[k];
      const r = createSchema.safeParse(raw);
      if (!r.success) { errors.push({ line, message: r.error.issues.map((i) => `${i.path[0] ?? ''} : ${i.message}`).join(' ; ') }); return; }
      if (r.data.taxId) {
        if (seenTax.has(r.data.taxId)) { errors.push({ line, message: 'Matricule fiscal en double dans le fichier' }); return; }
        seenTax.add(r.data.taxId);
      }
      valid.push({ line, data: r.data });
    });

    const result = { total: parsed.rows.length, valid: valid.length, errors, created: 0, dryRun: req.body.dryRun };
    if (req.body.dryRun || (errors.length && !req.body.skipInvalid)) return res.status(req.body.dryRun ? 200 : 422).json(req.body.dryRun ? { data: result } : { error: { code: 'IMPORT_HAS_ERRORS', message: 'Corrigez les lignes en erreur ou importez uniquement les lignes valides', details: result } });

    await withTransaction(async (conn) => {
      for (const v of valid) {
        try { await insertOne(conn, req.auth, v.data, req.ip); result.created++; }
        catch (e) { if (e instanceof HttpError && e.code === 'DUPLICATE_TAX_ID') errors.push({ line: v.line, message: e.message }); else throw e; }
      }
      if (errors.length && !req.body.skipInvalid) throw new HttpError(422, 'IMPORT_HAS_ERRORS', 'Import annulé : lignes en doublon', { ...result, created: 0 });
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${auditPrefix}.import`, entityType: table, ip: req.ip, meta: { created: result.created, rejected: errors.length } });
    });
    res.status(201).json({ data: result });
  }));

  router.post('/', requirePermission(`${perm}.write`), validate({ body: createSchema }), asyncHandler(async (req, res) => {
    const publicId = await withTransaction((conn) => insertOne(conn, req.auth, req.body, req.ip));
    res.status(201).json({ data: dto(await findOne(pool, req.auth.companyId, publicId)) });
  }));

  router.get('/:id', requirePermission(`${perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    res.json({ data: dto(await findOne(pool, req.auth.companyId, req.params.id)) });
  }));

  router.patch('/:id', requirePermission(`${perm}.write`), validate({ params: idParam, body: updateSchema }), asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const row = await findOne(conn, req.auth.companyId, req.params.id);
      const sets = []; const vals = [];
      for (const [k, v] of Object.entries(req.body)) {
        if (k === 'status') { sets.push('status = ?'); vals.push(v); } else if (COLS[k]) { sets.push(`${COLS[k]} = ?`); vals.push(v); }
      }
      if ('taxId' in req.body) await assertTaxIdFree(conn, req.auth.companyId, req.body.taxId, row.id);
      await conn.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`, [...vals, row.id, req.auth.companyId]);
      const action = req.body.status && req.body.status !== row.status ? (req.body.status === 'archived' ? 'archive' : 'restore') : 'update';
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${auditPrefix}.${action}`, entityType: table, entityId: row.public_id, ip: req.ip, meta: { fields: Object.keys(req.body) } });
    });
    res.json({ data: dto(await findOne(pool, req.auth.companyId, req.params.id)) });
  }));

  // Suppression physique : uniquement si rien n'y est rattache (FK -> 409 IN_USE) ; sinon archiver.
  router.delete('/:id', requirePermission(`${perm}.delete`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const row = await findOne(pool, req.auth.companyId, req.params.id);
    await pool.query(`DELETE FROM ${table} WHERE id = ? AND company_id = ?`, [row.id, req.auth.companyId]);
    await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${auditPrefix}.delete`, entityType: table, entityId: row.public_id, ip: req.ip, meta: { code: row.code } });
    res.status(204).end();
  }));

  return router;
}
