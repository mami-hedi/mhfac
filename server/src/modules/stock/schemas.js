import { z } from 'zod';
export const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ').refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s); }, 'Date invalide');
const dec = (re, msg) => z.union([z.string(), z.number()]).transform((v) => String(v).trim().replace(',', '.')).refine((s) => re.test(s), msg);
export const qtyPos = dec(/^\d{1,11}(\.\d{1,4})?$/, 'Quantité positive (4 décimales max)').refine((s) => Number(s) > 0, 'Quantité > 0');
export const qtyAny = dec(/^\d{1,11}(\.\d{1,4})?$/, 'Quantité invalide (4 décimales max)');
export const costField = dec(/^\d{1,11}(\.\d{1,4})?$/, 'Coût unitaire invalide (4 décimales max)');
export const opt = (s) => z.preprocess((v) => (v === '' || v === undefined ? null : v), s.nullable());
