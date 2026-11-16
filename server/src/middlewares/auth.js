import { pool } from '../config/db.js';
import { verifyAccessToken } from '../core/tokens.js';
import { HttpError } from '../utils/httpError.js';
import { effectiveStatus, isReadOnly } from '../core/plan.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// Même abonnement expiré ou annulé : on peut toujours se connecter, consulter et EXPORTER ses données ; toute écriture est refusée
// (sauf /auth, /subscription et /notifications : marquer une notification comme lue ne touche aucune donnée métier).
const ALWAYS_WRITABLE = /^\/api\/v1\/(auth|subscription|notifications)(\/|$)/; // testé sur le CHEMIN seul (pas la query string : '?x=/auth/' ne doit rien débloquer)
const pathOf = (url) => String(url).split('?')[0];

// Authentifie la requete et reconstruit le contexte DEPUIS LA BASE : l'entreprise et le role viennent
// du jeton signe + de company_members, jamais d'un en-tete, d'un parametre ou du corps de la requete.
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentification requise');

    let claims;
    try {
      claims = verifyAccessToken(header.slice(7));
    } catch {
      throw new HttpError(401, 'INVALID_TOKEN', 'Jeton invalide ou expiré');
    }

    const [[row]] = await pool.query(
      `SELECT cm.status AS member_status, u.status AS user_status, c.status AS company_status,
              r.id AS role_id, r.code AS role_code, s.status AS sub_status, s.trial_ends_at, s.current_period_end
         FROM company_members cm
         JOIN users u ON u.id = cm.user_id
         JOIN companies c ON c.id = cm.company_id
         JOIN roles r ON r.id = cm.role_id
         LEFT JOIN company_subscriptions s ON s.company_id = cm.company_id
        WHERE cm.user_id = ? AND cm.company_id = ?`,
      [claims.userId, claims.companyId],
    );
    if (!row) throw new HttpError(401, 'INVALID_TOKEN', 'Jeton invalide ou expiré');
    if (row.user_status !== 'active' || row.member_status !== 'active' || row.company_status !== 'active') {
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'Accès désactivé');
    }

    if (row.sub_status && !SAFE.has(req.method) && !ALWAYS_WRITABLE.test(pathOf(req.originalUrl)) && isReadOnly(effectiveStatus({ status: row.sub_status, trial_ends_at: row.trial_ends_at, current_period_end: row.current_period_end }))) {
      throw new HttpError(403, 'SUBSCRIPTION_INACTIVE', 'Votre abonnement est expiré ou annulé : l\'application est en lecture seule. Contactez l\'administrateur pour le renouveler.');
    }

    const [perms] = await pool.query(
      'SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?',
      [row.role_id],
    );
    req.auth = {
      userId: claims.userId,
      companyId: claims.companyId,
      role: row.role_code,
      permissions: new Set(perms.map((p) => p.code)),
    };
    next();
  } catch (err) {
    next(err);
  }
}

// Verifie les permissions sur chaque endpoint protege (toutes requises).
export const requirePermission = (...codes) => {
  const mw = (req, _res, next) => {
    const missing = codes.filter((c) => !req.auth?.permissions.has(c));
    if (missing.length) return next(new HttpError(403, 'FORBIDDEN', 'Permission insuffisante', { required: missing }));
    next();
  };
  mw.requiredPermissions = codes; // lu par scripts/gen-api-docs.js (documentation générée depuis le code)
  return mw;
};
