// Validation / nettoyage de ce que l'extracteur renvoie (donnée NON FIABLE) + rapprochement fournisseur + contrôle des totaux.
import { z } from 'zod';

const num = z.preprocess((v) => (v === '' || v === undefined ? null : typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : v), z.number().finite().nullable());
const str = (max) => z.preprocess((v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null), z.string().nullable());
const date = z.preprocess((v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && !Number.isNaN(Date.parse(v.trim())) ? v.trim() : null), z.string().nullable());
const schema = z.object({
  documentType: z.enum(['invoice', 'credit_note', 'unknown']).catch('unknown'),
  supplier: z.object({ name: str(190), taxId: str(40), address: str(500), email: str(190), phone: str(40) }).partial().catch({}),
  documentNumber: str(60), issueDate: date, dueDate: date,
  currency: z.preprocess((v) => (typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null), z.string().nullable()),
  lines: z.array(z.object({ description: str(500), quantity: num, unitPriceExclTax: num, discountPct: num, taxRatePct: num })).max(200).catch([]),
  totals: z.object({ totalExclTax: num, totalTax: num, totalInclTax: num, stampDuty: num, withholdingAmount: num }).partial().catch({}),
  notes: str(3000),
  warnings: z.array(z.string().max(200)).max(20).catch([]),
}).partial();

export function normalize(raw) {
  const p = schema.parse(raw && typeof raw === 'object' ? raw : {});
  const lines = (p.lines ?? []).filter((l) => l.description).map((l) => ({ description: l.description, quantity: l.quantity != null && l.quantity > 0 ? l.quantity : null, unitPriceExclTax: l.unitPriceExclTax != null && l.unitPriceExclTax >= 0 ? l.unitPriceExclTax : null,
    discountPct: l.discountPct != null && l.discountPct >= 0 && l.discountPct <= 100 ? l.discountPct : 0, taxRatePct: l.taxRatePct != null && l.taxRatePct >= 0 && l.taxRatePct <= 100 ? l.taxRatePct : null }));
  const warnings = [...(p.warnings ?? [])];
  if (!p.documentNumber) warnings.push('N° de facture non lu');
  if (!p.issueDate) warnings.push('Date de facture non lue');
  if (!p.supplier?.name) warnings.push('Fournisseur non identifié');
  if (!lines.length) warnings.push('Aucune ligne lue');
  if (lines.some((l) => l.quantity == null || l.unitPriceExclTax == null)) warnings.push('Quantité ou prix manquant sur certaines lignes');
  if (lines.some((l) => l.taxRatePct == null)) warnings.push('Taux de TVA non lu sur certaines lignes');
  return { documentType: p.documentType ?? 'unknown', supplier: p.supplier ?? {}, documentNumber: p.documentNumber ?? null, issueDate: p.issueDate ?? null, dueDate: p.dueDate ?? null, currency: p.currency ?? null, lines, totals: p.totals ?? {}, notes: p.notes ?? null, warnings };
}

const key = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
// Rapprochement : matricule fiscal identique (fiable), sinon nom identique ; jamais d'approximation silencieuse.
export function matchSupplier(ex, suppliers) {
  const tax = key(ex?.taxId); const name = key(ex?.name);
  const byTax = tax.length >= 5 ? suppliers.find((s) => key(s.tax_id) === tax) : null;
  const hit = byTax ?? (name ? suppliers.find((s) => key(s.name) === name) : null);
  return hit ? { id: hit.public_id, code: hit.code, name: hit.name, by: byTax ? 'tax_id' : 'name' } : null;
}

// Compare ce que le document imprime à ce que le moteur serveur a calculé (tolérance 0,010).
export function compareTotals(printed, computed) {
  const out = []; const chk = (label, a, b) => { if (a != null && Math.abs(Number(a) - Number(b)) > 0.0105) out.push(`${label} : document ${Number(a).toFixed(3)} ≠ calculé ${Number(b).toFixed(3)}`); };
  chk('Total HT', printed?.totalExclTax, computed.totalHt); chk('TVA', printed?.totalTax, computed.totalTax);
  if (printed?.totalInclTax != null) chk('Total TTC (hors timbre)', printed.totalInclTax - (printed.stampDuty ?? 0), computed.totalTtc);
  return out;
}
