// Numérotation des documents : lecture et réglage par type (préfixe, séparateur, année, remise à zéro annuelle, largeur, prochain numéro).
// Les numéros déjà attribués ne changent jamais ; le compteur ne peut qu'augmenter ; chaque préfixe est unique dans l'entreprise.
import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { DOC_TYPES, SEPARATORS, buildNumber, configOf, seriesOf, getNumbering } from '../../core/numbering.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { HttpError } from '../../utils/httpError.js';
import { todayTunis } from '../sales/common.js';
import { getSettings, saveSettings } from './settings.js';

const router = Router();

const item = z.object({
  docType: z.enum(Object.keys(DOC_TYPES)),
  prefix: z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/, 'Préfixe : 1 à 10 lettres ou chiffres, sans espace ni symbole').transform((v) => v.toUpperCase()),
  separator: z.enum(SEPARATORS),
  includeYear: z.boolean(),
  yearlyReset: z.boolean(),
  width: z.coerce.number().int().min(3, 'Au moins 3 chiffres').max(8, '8 chiffres au maximum'),
  nextNumber: z.coerce.number().int().min(1).max(999_999_999).nullable().optional(),
}).refine((v) => !v.yearlyReset || v.includeYear, { message: 'Avec une remise à zéro chaque année, l\'année doit figurer dans le numéro (sinon deux années auraient le même numéro).', path: ['includeYear'] });
const putSchema = z.object({ items: z.array(item).min(1).max(40) }).refine((b) => new Set(b.items.map((i) => i.docType)).size === b.items.length, 'Type de document en double');

const lastOf = async (conn, companyId, docType, series) => {
  const [[r]] = await conn.query('SELECT last_number FROM document_sequences WHERE company_id = ? AND doc_type = ? AND series = ?', [companyId, docType, series]);
  return r ? Number(r.last_number) : 0;
};
const view = async (conn, companyId) => {
  const stored = await getNumbering(conn, companyId); const year = todayTunis().slice(0, 4);
  const out = [];
  for (const [docType, def] of Object.entries(DOC_TYPES)) {
    const cfg = configOf(docType, stored[docType]); const last = await lastOf(conn, companyId, docType, seriesOf(cfg, year));
    out.push({ docType, label: def.label, group: def.group, defaultPrefix: def.prefix, ...cfg, lastNumber: last, nextNumber: last + 1, example: buildNumber(cfg, year, last + 1) });
  }
  return { year, items: out };
};

router.get('/', requirePermission('settings.read'), asyncHandler(async (req, res) => {
  await withTransaction(async (conn) => res.json({ data: await view(conn, req.auth.companyId) }));
}));

router.put('/', requirePermission('settings.write'), validate({ body: putSchema }), asyncHandler(async (req, res) => {
  const { companyId, userId } = req.auth; const year = todayTunis().slice(0, 4);
  const data = await withTransaction(async (conn) => {
    await conn.query('SELECT settings FROM company_settings WHERE company_id = ? FOR UPDATE', [companyId]); // sérialise deux enregistrements simultanés
    const stored = await getNumbering(conn, companyId);
    const next = {}; for (const t of Object.keys(DOC_TYPES)) next[t] = configOf(t, stored[t]);
    const changes = [];
    for (const it of req.body.items) {
      const { docType, nextNumber, ...cfg } = it; const before = next[docType]; next[docType] = { ...before, ...cfg };
      changes.push({ docType, before, after: next[docType], nextNumber });
    }
    // un préfixe appartient à un seul type de document : sinon deux documents différents pourraient porter le même numéro
    const seen = new Map();
    for (const [t, cfg] of Object.entries(next)) { const k = cfg.prefix.toUpperCase(); if (seen.has(k)) throw new HttpError(400, 'PREFIX_DUPLICATE', `Le préfixe « ${cfg.prefix} » est utilisé à la fois par « ${DOC_TYPES[seen.get(k)].label} » et « ${DOC_TYPES[t].label} ». Choisissez un préfixe différent pour chacun.`); seen.set(k, t); }

    for (const ch of changes) {
      const { docType, before, after } = ch; const target = seriesOf(after, year);
      // passage remise à zéro annuelle <-> numérotation continue : la nouvelle série repart AU PLUS HAUT numéro déjà utilisé (aucun doublon possible)
      if (before.yearlyReset !== after.yearlyReset) {
        const [[m]] = await conn.query('SELECT COALESCE(MAX(last_number), 0) AS m FROM document_sequences WHERE company_id = ? AND doc_type = ?', [companyId, docType]);
        await conn.query('INSERT INTO document_sequences (company_id, doc_type, series, last_number) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number))', [companyId, docType, target, Number(m.m)]);
      }
      if (ch.nextNumber != null) {
        const last = await lastOf(conn, companyId, docType, target);
        if (ch.nextNumber - 1 < last) throw new HttpError(400, 'COUNTER_LOWER', `« ${DOC_TYPES[docType].label} » : le prochain numéro ne peut pas être inférieur à ${last + 1} (des numéros jusqu'à ${last} existent déjà).`);
        if (ch.nextNumber - 1 > last) await conn.query('INSERT INTO document_sequences (company_id, doc_type, series, last_number) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE last_number = VALUES(last_number)', [companyId, docType, target, ch.nextNumber - 1]);
      }
    }
    await saveSettings(companyId, { numbering: next }, conn);
    await audit(conn, { companyId, userId, action: 'company.numbering_updated', entityType: 'company', entityId: companyId, ip: req.ip, meta: { changes: changes.map((c) => ({ docType: c.docType, before: c.before, after: c.after, nextNumber: c.nextNumber ?? null })) } });
    return view(conn, companyId);
  });
  res.json({ data });
}));

export default router;
