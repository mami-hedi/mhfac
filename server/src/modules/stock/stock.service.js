// Moteur de stock : TOUS les mouvements passent par moveStock(), dans la transaction de l'appelant.
// - Valorisation au coût moyen pondéré (CMUP) par article, calculée en entiers (BigInt), jamais en flottants.
// - Verrou de ligne par article (product_stock) pris dans l'ordre des identifiants : pas d'interblocage, opérations concurrentes sérialisées.
// - Journal immuable ; unicité (source, ligne, nature) : rejouer une opération ne crée pas un deuxième mouvement.
import { newPublicId } from '../../core/ids.js';
import { HttpError } from '../../utils/httpError.js';
import { toScaled as unsignedScaled, fromScaled } from '../../core/calc.js';
import { getSettings } from '../companies/settings.js';

// toScaled signé (les quantités de mouvement et les stocks négatifs autorisés peuvent être < 0)
const toScaled = (v, scale) => { const s = String(v ?? '0').trim(); return s.startsWith('-') ? -unsignedScaled(s.slice(1), scale) : unsignedScaled(s, scale); };
export { toScaled as signedScaled };
const Q = 4; const C = 4; // échelles : quantités et coûts unitaires à 4 décimales
const abs = (x) => (x < 0n ? -x : x);
// (a / b) arrondi au plus proche, demi supérieur en valeur absolue
const divRound = (a, b) => { const neg = (a < 0n) !== (b < 0n); const n = (abs(a) * 2n + abs(b)) / (abs(b) * 2n); return neg ? -n : n; };
// quantité(4) x coût(4) = échelle 8 -> montant à 3 décimales
export const lineCost = (q4, c4) => divRound(q4 * c4, 100_000n);

export async function ensureDefaultWarehouse(conn, companyId, userId = null) {
  const [[w]] = await conn.query("SELECT id FROM warehouses WHERE company_id = ? AND status = 'active' ORDER BY is_default DESC, id LIMIT 1", [companyId]);
  if (w) return w.id;
  const [r] = await conn.query('INSERT INTO warehouses (public_id, company_id, code, name, is_default, created_by) VALUES (?,?,?,?,1,?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [newPublicId(), companyId, 'PRINC', 'Entrepôt principal', userId]);
  return r.insertId;
}

export async function findWarehouse(conn, companyId, publicId, { activeOnly = true } = {}) {
  const [[w]] = await conn.query('SELECT * FROM warehouses WHERE company_id = ? AND public_id = ?', [companyId, publicId]);
  if (!w) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Entrepôt introuvable');
  if (activeOnly && w.status !== 'active') throw new HttpError(422, 'WAREHOUSE_ARCHIVED', `L'entrepôt « ${w.name} » est archivé`);
  return w;
}

// items : [{ productId, warehouseId, kind, quantity (signée, chaîne), unitCost? (entrées), date, reason?, source:{type,id,number,lineId} }]
// Règle de coût : entrée -> unitCost fourni (CMUP recalculé) ; sortie -> coût moyen courant ; transferts -> coût moyen inchangé.
export async function moveStock(conn, { companyId, userId, allowNegative }, items) {
  if (allowNegative === undefined) allowNegative = (await getSettings(companyId, conn)).stock.allowNegative;
  const ordered = items.map((it, i) => ({ ...it, i })).sort((a, b) => Number(a.productId) - Number(b.productId) || a.i - b.i);
  const products = new Map();
  const out = new Array(items.length);
  for (const it of ordered) {
    const pid = Number(it.productId);
    if (!products.has(pid)) {
      const [[p]] = await conn.query('SELECT id, name, sku, track_stock, type, status FROM products WHERE id = ? AND company_id = ?', [pid, companyId]);
      if (!p) throw new HttpError(422, 'UNKNOWN_REFERENCE', 'Article introuvable');
      if (!p.track_stock || p.type !== 'product') throw new HttpError(422, 'NOT_TRACKED', `« ${p.name} » n'est pas suivi en stock (activez « Suivre le stock » sur l'article)`);
      // upsert = verrou de ligne tenu jusqu'au commit (même technique que la numérotation)
      await conn.query('INSERT INTO product_stock (product_id, company_id) VALUES (?,?) ON DUPLICATE KEY UPDATE product_id = product_id', [pid, companyId]);
      const [[ps]] = await conn.query('SELECT quantity, avg_cost FROM product_stock WHERE product_id = ? FOR UPDATE', [pid]);
      products.set(pid, { p, qty: toScaled(ps.quantity, Q), avg: toScaled(ps.avg_cost, C), touched: false });
    }
    const st = products.get(pid);
    await conn.query('INSERT INTO stock_levels (product_id, warehouse_id, company_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE product_id = product_id', [pid, it.warehouseId, companyId]);
    const [[lv]] = await conn.query('SELECT quantity FROM stock_levels WHERE product_id = ? AND warehouse_id = ? FOR UPDATE', [pid, it.warehouseId]);
    const q = toScaled(it.quantity, Q);
    if (q === 0n) throw new HttpError(422, 'INVALID_QUANTITY', 'Quantité nulle');
    const whAfter = toScaled(lv.quantity, Q) + q;
    if (whAfter < 0n && !allowNegative) {
      throw new HttpError(409, 'STOCK_INSUFFICIENT', `Stock insuffisant pour « ${st.p.name} » : disponible ${fromScaled(toScaled(lv.quantity, Q), Q)}, demandé ${fromScaled(-q, Q)}`, { productId: it.publicProductId ?? null, available: fromScaled(toScaled(lv.quantity, Q), Q) });
    }
    let unit; const transfer = it.kind === 'transfer_in' || it.kind === 'transfer_out';
    if (q > 0n && !transfer) {
      unit = it.unitCost !== undefined && it.unitCost !== null ? toScaled(it.unitCost, C) : st.avg;
      // CMUP : (valeur existante + valeur entrante) / quantité totale ; stock nul ou négatif -> le coût d'entrée repart à zéro
      st.avg = st.qty <= 0n ? unit : divRound(st.qty * st.avg + q * unit, st.qty + q);
    } else unit = st.avg;
    st.qty += q; st.touched = true;
    const total = lineCost(q, unit);
    const publicId = newPublicId();
    try {
      await conn.query(
        `INSERT INTO stock_movements (public_id, company_id, product_id, warehouse_id, kind, quantity, unit_cost, total_cost, balance_after, avg_cost_after, movement_date, reason, source_type, source_id, source_number, source_line_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [publicId, companyId, pid, it.warehouseId, it.kind, fromScaled(q, Q), fromScaled(unit, C), fromScaled(total, 3), fromScaled(whAfter, Q), fromScaled(st.avg, C), it.date, it.reason ?? null, it.source.type, it.source.id ?? null, it.source.number ?? null, it.source.lineId ?? null, userId]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'ALREADY_APPLIED', 'Cette opération a déjà généré ses mouvements de stock');
      throw e;
    }
    await conn.query('UPDATE stock_levels SET quantity = ? WHERE product_id = ? AND warehouse_id = ?', [fromScaled(whAfter, Q), pid, it.warehouseId]);
    out[it.i] = { id: publicId, productId: pid, quantity: fromScaled(q, Q), unitCost: fromScaled(unit, C), totalCost: fromScaled(total, 3) };
  }
  for (const [pid, st] of products) {
    if (st.touched) await conn.query('UPDATE product_stock SET quantity = ?, avg_cost = ? WHERE product_id = ?', [fromScaled(st.qty, Q), fromScaled(st.avg, C), pid]);
  }
  return out;
}

// Mouvements inverses d'une opération (annulation) : relit le journal de la source.
export async function reverseSource(conn, ctx, { companyId, type, id, number, kinds, reverseKind, date, reason, costRule }) {
  const [rows] = await conn.query('SELECT * FROM stock_movements WHERE company_id = ? AND source_type = ? AND source_id = ? AND kind IN (?) ORDER BY id', [companyId, type, id, kinds]);
  const items = rows.map((m) => {
    const q = toScaled(m.quantity, Q);
    // une sortie annulée rentre au coût d'origine ; une entrée annulée ressort au coût moyen courant
    return { productId: m.product_id, warehouseId: m.warehouse_id, kind: reverseKind, quantity: fromScaled(-q, Q), unitCost: q < 0n ? m.unit_cost : undefined, date, reason,
      source: { type, id, number, lineId: m.id } };
  });
  void costRule;
  if (items.length) await moveStock(conn, ctx, items);
  return items.length;
}
