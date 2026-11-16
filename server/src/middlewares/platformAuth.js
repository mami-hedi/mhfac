import { pool } from '../config/db.js';
import { verifyAccessToken } from '../core/tokens.js';
import { HttpError } from '../utils/httpError.js';

// Espace plateforme (super administrateur) : le droit vient de users.is_platform_admin LU EN BASE à chaque requête (jamais du jeton ni d'un en-tête).
// Un super administrateur gère entreprises, offres et abonnements ; il n'a PAS accès aux données métier des entreprises.
export async function authenticatePlatform(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentification requise');
    let claims;
    try { claims = verifyAccessToken(header.slice(7)); } catch { throw new HttpError(401, 'INVALID_TOKEN', 'Jeton invalide ou expiré'); }
    const [[u]] = await pool.query('SELECT id, status, is_platform_admin FROM users WHERE id = ?', [claims.userId]);
    if (!u || u.status !== 'active') throw new HttpError(401, 'INVALID_TOKEN', 'Jeton invalide ou expiré');
    if (!u.is_platform_admin) throw new HttpError(403, 'FORBIDDEN', 'Réservé à l\'administration de la plateforme');
    req.platform = { userId: u.id };
    next();
  } catch (e) { next(e); }
}
