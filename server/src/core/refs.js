import { HttpError } from '../utils/httpError.js';

// Resout un identifiant public en identifiant interne DANS l'entreprise : une reference vers une autre
// entreprise est rejetee comme inconnue (pas d'IDOR via un champ de formulaire).
const TABLES = new Set(['tax_rates', 'product_categories']);
export async function resolveRef(conn, table, companyId, publicId, label) {
  if (publicId === null || publicId === undefined) return null;
  if (!TABLES.has(table)) throw new Error('table non autorisee');
  const [[row]] = await conn.query(`SELECT id FROM ${table} WHERE company_id = ? AND public_id = ?`, [companyId, publicId]);
  if (!row) throw new HttpError(422, 'UNKNOWN_REFERENCE', `${label} introuvable`);
  return row.id;
}
