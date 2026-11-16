// Scan de facture fournisseur : le document est lu automatiquement, puis l'utilisateur RELIT et crée un brouillon de facture d'achat.
// Garde-fous : la lecture n'est qu'une suggestion (jamais enregistrée comme facture sans relecture) ; calculs refaits côté serveur ;
// doublon de fichier refusé ; totaux recalculés comparés à ceux imprimés ; limite horaire ; clé API jamais exposée.
import { createHash } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { HttpError } from '../../utils/httpError.js';
import { newPublicId } from '../../core/ids.js';
import { audit } from '../../core/audit.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { bodyBase } from '../sales/common.js';
import { purchaseBase } from '../purchases/common.js';
import { insertPurchaseInvoice, stockOpts } from '../purchases/invoices.routes.js';
import { assertFeature, assertLimit } from '../../core/plan.js';
import { getExtractor } from './extractor.js';
import { normalize, matchSupplier, compareTotals } from './normalize.js';

const router = Router();
router.use(authenticate);
const MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const idParam = z.object({ id: z.string().uuid() });
// Le type est déduit du CONTENU (octets magiques), jamais de l'en-tête ni de l'extension envoyés par le client.
const sniff = (b) => (b.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg' : b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null);
const safeName = (n) => String(n ?? 'facture').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 150) || 'facture';

const dto = async (conn, companyId, r) => {
  const extraction = typeof r.extraction === 'string' ? JSON.parse(r.extraction) : r.extraction;
  const [sups] = await conn.query("SELECT public_id, code, name, tax_id FROM suppliers WHERE company_id = ? AND status = 'active'", [companyId]);
  const supplier = matchSupplier(extraction.supplier, sups);
  const [[inv]] = r.purchase_invoice_id ? await conn.query('SELECT public_id, status, number FROM purchase_invoices WHERE id = ?', [r.purchase_invoice_id]) : [[null]];
  return { id: r.public_id, status: r.status, fileName: r.file_name, mimeType: r.mime_type, size: r.file_size, extractor: r.extractor, createdAt: r.created_at, extraction, supplierMatch: supplier, invoice: inv ? { id: inv.public_id, status: inv.status } : null, notice: 'Lecture automatique non vérifiée : relisez chaque champ avant de créer le brouillon.' };
};

router.post('/', requirePermission('purchase.write'),
  express.raw({ type: () => true, limit: `${env.SCAN_MAX_MB}mb` }),
  asyncHandler(async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, 'FILE_REQUIRED', 'Envoyez le document en corps de requête (PDF, PNG, JPEG ou WebP)');
    const mime = sniff(buf);
    if (!mime || !MIMES.includes(mime)) throw new HttpError(415, 'UNSUPPORTED_FILE', 'Format non pris en charge : PDF, PNG, JPEG ou WebP uniquement');
    const hash = createHash('sha256').update(buf).digest('hex');
    const [[dup]] = await pool.query('SELECT public_id, status FROM purchase_scans WHERE company_id = ? AND file_sha256 = ?', [req.auth.companyId, hash]);
    if (dup) throw new HttpError(409, 'DUPLICATE_SCAN', 'Ce document a déjà été scanné', { scanId: dup.public_id, status: dup.status });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM purchase_scans WHERE company_id = ? AND created_at > (UTC_TIMESTAMP() - INTERVAL 1 HOUR)', [req.auth.companyId]);
    if (n >= env.SCAN_HOURLY_LIMIT) throw new HttpError(429, 'SCAN_RATE_LIMIT', `Limite de ${env.SCAN_HOURLY_LIMIT} scans par heure atteinte : réessayez plus tard`);
    await assertFeature(pool, req.auth.companyId, 'purchaseScan');
    await assertLimit(pool, req.auth.companyId, 'scansPerMonth');
    const ex = getExtractor();
    const raw = await ex.extract({ buffer: buf, mime });
    const extraction = normalize(raw);
    const publicId = newPublicId();
    await withTransaction(async (conn) => {
      await conn.query('INSERT INTO purchase_scans (public_id, company_id, file_name, mime_type, file_size, file_sha256, file_data, extractor, extraction, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [publicId, req.auth.companyId, safeName(req.query.filename), mime, buf.length, hash, buf, ex.id, JSON.stringify(extraction), req.auth.userId]);
      await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_scan.create', entityType: 'purchase_scans', entityId: publicId, ip: req.ip, meta: { size: buf.length, mime, extractor: ex.id } });
    });
    const [[r]] = await pool.query('SELECT * FROM purchase_scans WHERE public_id = ?', [publicId]);
    res.status(201).json({ data: await dto(pool, req.auth.companyId, r) });
  }));

router.get('/', requirePermission('purchase.read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(`SELECT s.public_id, s.status, s.file_name, s.file_size, s.created_at, JSON_UNQUOTE(JSON_EXTRACT(s.extraction,'$.supplier.name')) AS supplier_name, JSON_UNQUOTE(JSON_EXTRACT(s.extraction,'$.documentNumber')) AS doc_number,
      i.public_id AS invoice_pid FROM purchase_scans s LEFT JOIN purchase_invoices i ON i.id = s.purchase_invoice_id WHERE s.company_id = ? ORDER BY s.id DESC LIMIT 100`, [req.auth.companyId]);
  res.json({ data: rows.map((r) => ({ id: r.public_id, status: r.status, fileName: r.file_name, size: r.file_size, createdAt: r.created_at, supplierName: r.supplier_name, documentNumber: r.doc_number, invoiceId: r.invoice_pid })) });
}));

const load = async (conn, companyId, pid, forUpdate = false) => {
  const [[r]] = await conn.query(`SELECT * FROM purchase_scans WHERE company_id = ? AND public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, pid]);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Scan introuvable');
  return r;
};
router.get('/:id', requirePermission('purchase.read'), validate({ params: idParam }), asyncHandler(async (req, res) => { res.json({ data: await dto(pool, req.auth.companyId, await load(pool, req.auth.companyId, req.params.id)) }); }));
router.get('/:id/file', requirePermission('purchase.read'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const r = await load(pool, req.auth.companyId, req.params.id);
  res.set({ 'Content-Type': r.mime_type, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.file_name)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.send(r.file_data);
}));

// Crée le brouillon à partir des valeurs RELUES/CORRIGÉES par l'utilisateur ; tous les calculs sont refaits par le moteur serveur.
const draftBody = z.object({ ...purchaseBase, supplierRef: z.string().trim().min(1, 'N° du document fournisseur requis').max(60), dueDate: bodyBase.issueDate.optional(), ...stockOpts });
router.post('/:id/draft', requirePermission('purchase.write'), validate({ params: idParam, body: draftBody }), asyncHandler(async (req, res) => {
  let out; let warnings = [];
  await withTransaction(async (conn) => {
    const scan = await load(conn, req.auth.companyId, req.params.id, true);
    if (scan.status !== 'extracted') throw new HttpError(409, 'SCAN_ALREADY_USED', 'Ce scan a déjà été converti ou abandonné');
    const extraction = typeof scan.extraction === 'string' ? JSON.parse(scan.extraction) : scan.extraction;
    if (extraction.documentType === 'credit_note') throw new HttpError(422, 'UNSUPPORTED_DOCUMENT_TYPE', 'Ce document semble être un avoir : saisissez-le depuis la facture d\'achat concernée (Avoirs fournisseur).');
    const created = await insertPurchaseInvoice(conn, req.auth, req.body, {}, { ip: req.ip, meta: { scanId: scan.public_id } });
    const [[inv]] = await conn.query('SELECT id, total_ht, total_tax, total_ttc FROM purchase_invoices WHERE public_id = ?', [created.publicId]);
    await conn.query("UPDATE purchase_scans SET status = 'converted', purchase_invoice_id = ? WHERE id = ?", [inv.id, scan.id]);
    warnings = compareTotals(extraction.totals, { totalHt: inv.total_ht, totalTax: inv.total_tax, totalTtc: inv.total_ttc });
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_scan.convert', entityType: 'purchase_scans', entityId: scan.public_id, ip: req.ip, meta: { invoice: created.publicId, warnings: warnings.length } });
    out = created.publicId;
  });
  res.status(201).json({ data: { invoiceId: out, warnings } });
}));

router.delete('/:id', requirePermission('purchase.write'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => {
    const scan = await load(conn, req.auth.companyId, req.params.id, true);
    if (scan.status === 'converted') throw new HttpError(409, 'SCAN_ALREADY_USED', 'Ce scan est lié à une facture d\'achat et ne peut pas être abandonné');
    await conn.query("UPDATE purchase_scans SET status = 'discarded' WHERE id = ?", [scan.id]);
    await audit(conn, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'purchase_scan.discard', entityType: 'purchase_scans', entityId: scan.public_id, ip: req.ip });
  });
  res.status(204).end();
}));
export default router;
