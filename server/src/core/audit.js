import { pool } from '../config/db.js';

// Ne jamais passer de mot de passe ou de jeton dans meta.
export async function audit(conn, { companyId = null, userId = null, action, entityType = null, entityId = null, ip = null, meta = null }) {
  await (conn ?? pool).query(
    'INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, ip, meta) VALUES (?,?,?,?,?,?,?)',
    [companyId, userId, action, entityType, entityId === null ? null : String(entityId), ip, meta ? JSON.stringify(meta) : null],
  );
}
