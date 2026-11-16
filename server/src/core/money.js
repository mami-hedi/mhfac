import { z } from 'zod';

// Decimal sur chaine : jamais de flottant pour un montant. "12,5" ou 12.5 -> "12.500" (scale 3).
export function parseDecimal(input, { scale = 3, maxIntDigits = 12 } = {}) {
  const raw = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : String(input ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error('Nombre positif attendu');
  const [int0, frac = ''] = raw.split('.');
  const int = int0.replace(/^0+(?=\d)/, '');
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) throw new Error(`${scale} décimales maximum`);
  if (int.length > maxIntDigits) throw new Error('Valeur trop grande');
  return `${int}.${frac.padEnd(scale, '0').slice(0, scale)}`;
}

export const decimalField = (opts) =>
  z.union([z.string(), z.number()]).transform((v, ctx) => {
    try { return parseDecimal(v, opts); } catch (e) { ctx.addIssue({ code: 'custom', message: e.message }); return z.NEVER; }
  });
