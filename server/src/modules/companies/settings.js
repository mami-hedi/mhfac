import { z } from 'zod';
import { pool } from '../../config/db.js';

const txt = (n) => z.string().trim().max(n);
const money3 = z.string().trim().regex(/^\d{1,12}([.,]\d{1,3})?$/, 'Montant invalide').transform((v) => { const [i, f = ''] = v.replace(',', '.').split('.'); return `${i}.${f.padEnd(3, '0')}`; });
const pct2 = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const s = String(v).trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s) || Number(s) > 100) { ctx.addIssue({ code: 'custom', message: 'Pourcentage entre 0 et 100 (2 décimales max)' }); return z.NEVER; }
  const [i, f = ''] = s.split('.'); return `${Number(i)}.${f.padEnd(2, '0')}`;
});

// Aucune valeur fiscale n'est figée : timbre désactivé et à 0 par défaut, retenue à 0 — à paramétrer et faire valider.
export const DEFAULT_SETTINGS = {
  identity: { address: '', governorate: '', postalCode: '', phone: '', email: '', website: '', tradeRegister: '' },
  branding: { logo: null, accentColor: '#1d4ed8', template: 'classic', pdfLanguage: 'fr', headerStyle: 'classic', headerText: '', headerAlign: 'left', showLogo: true, footerStyle: 'classic', footerText: '', footerAlign: 'center', showPageNumber: true },
  sales: { fodecEnabled: false, fodecRate: '1.00', stampDutyEnabled: false, stampDutyAmount: '0.000', defaultWithholdingPct: '0.00', quoteValidityDays: 30, defaultPaymentTermsDays: 0, defaultTerms: '', legalMentions: '', paymentInfo: '' },
  numbering: {}, // numérotation des documents (par type) : géré uniquement par /companies/current/numbering
  stock: { allowNegative: true }, // choix produit : stock négatif autorisé par défaut (alerte dans l'inventaire) ; désactivable
};

// Le type annoncé ne suffit pas : les premiers octets décodés doivent être ceux d'un vrai PNG ou JPEG (un fichier HTML/SVG déguisé est refusé).
const isRealImage = (dataUrl) => {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl); if (!m) return false;
  const head = Buffer.from(m[2].slice(0, 24), 'base64');
  return m[1] === 'png' ? head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) : head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
};
const logo = z.string().max(400_000, 'Logo trop volumineux (environ 300 Ko maximum après réduction)').regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, 'Logo : PNG ou JPEG uniquement')
  .refine(isRealImage, 'Le fichier n\'est pas une image PNG ou JPEG valide').nullable();
// Mise en page des documents : en-tête et pied de page au choix + modèle personnalisé (texte libre, plusieurs lignes, sans balisage).
const freeText = (n) => z.string().max(n).transform((v) => v.replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim());
export const frameFields = {
  headerStyle: z.enum(['classic', 'centered', 'band', 'minimal', 'custom']), headerText: freeText(600), headerAlign: z.enum(['left', 'center', 'right']), showLogo: z.boolean(),
  footerStyle: z.enum(['classic', 'columns', 'minimal', 'custom']), footerText: freeText(400), footerAlign: z.enum(['left', 'center', 'right']), showPageNumber: z.boolean(),
};
export const settingsPatchSchema = z.object({
  identity: z.object({ address: txt(255), governorate: txt(100), postalCode: txt(20), phone: txt(40), email: txt(190), website: txt(190), tradeRegister: txt(60) }).partial(),
  branding: z.object({ logo, accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur #RRGGBB'), template: z.enum(['classic', 'modern', 'minimal']), pdfLanguage: z.literal('fr'), ...frameFields }).partial(),
  sales: z.object({
    fodecEnabled: z.boolean(), fodecRate: pct2, stampDutyEnabled: z.boolean(), stampDutyAmount: money3, defaultWithholdingPct: pct2,
    quoteValidityDays: z.coerce.number().int().min(1).max(365), defaultPaymentTermsDays: z.coerce.number().int().min(0).max(365),
    defaultTerms: txt(3000), legalMentions: txt(3000), paymentInfo: txt(1000),
  }).partial(),
  stock: z.object({ allowNegative: z.boolean() }).partial(),
}).partial().refine((o) => Object.values(o).some((x) => x !== undefined), 'Aucune modification');

const merge = (base, patch) => Object.fromEntries(Object.keys(base).map((k) => [k, { ...base[k], ...(patch?.[k] ?? {}) }]));

export async function getSettings(companyId, conn = pool) {
  const [[row]] = await conn.query('SELECT settings FROM company_settings WHERE company_id = ?', [companyId]);
  const stored = row ? (typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings) : {};
  const out = merge(DEFAULT_SETTINGS, stored);
  out.branding.pdfLanguage = 'fr'; // anciens réglages « arabe » ignorés : documents en français uniquement
  return out;
}

export async function saveSettings(companyId, patch, conn = pool) {
  const next = merge(await getSettings(companyId, conn), patch);
  await conn.query('INSERT INTO company_settings (company_id, settings) VALUES (?, ?) ON DUPLICATE KEY UPDATE settings = VALUES(settings)', [companyId, JSON.stringify(next)]);
  return next;
}
