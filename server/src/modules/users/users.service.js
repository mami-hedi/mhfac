import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit.js';
import { assertLimit } from '../../core/plan.js';
import { newPublicId } from '../../core/ids.js';
import { clientUrl, sendMail } from '../../core/mailer.js';
import { randomToken, sha256 } from '../../core/tokens.js';
import { HttpError } from '../../utils/httpError.js';

// Regles de delegation : seul le proprietaire gere les administrateurs ; le role proprietaire n'est jamais attribuable.
function assertCanAssign(actorRole, targetRoleCode) {
  if (targetRoleCode === 'owner') throw new HttpError(422, 'ROLE_NOT_ASSIGNABLE', 'Le rôle propriétaire ne peut pas être attribué');
  if (targetRoleCode === 'admin' && actorRole !== 'owner') {
    throw new HttpError(403, 'FORBIDDEN', 'Seul le propriétaire peut attribuer le rôle administrateur');
  }
}
function assertCanManageTarget(actorRole, targetRole) {
  if (targetRole === 'owner') throw new HttpError(403, 'FORBIDDEN', 'Le propriétaire ne peut pas être modifié');
  if (targetRole === 'admin' && actorRole !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'Seul le propriétaire peut gérer un administrateur');
}

async function roleByCode(conn, code) {
  const [[r]] = await conn.query('SELECT id, code FROM roles WHERE code = ?', [code]);
  if (!r) throw new HttpError(422, 'UNKNOWN_ROLE', 'Rôle inconnu');
  return r;
}

export async function listMembers(companyId) {
  const [rows] = await pool.query(
    `SELECT u.public_id, u.email, u.full_name, u.last_login_at, cm.status, cm.created_at, r.code AS role
       FROM company_members cm JOIN users u ON u.id = cm.user_id JOIN roles r ON r.id = cm.role_id
      WHERE cm.company_id = ? ORDER BY cm.created_at`,
    [companyId],
  );
  return rows.map((r) => ({ id: r.public_id, email: r.email, fullName: r.full_name, role: r.role, status: r.status, lastLoginAt: r.last_login_at, joinedAt: r.created_at }));
}

// Recherche d'un membre PAR entreprise : un id d'une autre entreprise donne 404 (pas 403, pas de fuite d'existence).
async function findMember(conn, companyId, userPublicId) {
  const [[m]] = await conn.query(
    `SELECT cm.id, cm.user_id, cm.status, r.code AS role FROM company_members cm
       JOIN users u ON u.id = cm.user_id JOIN roles r ON r.id = cm.role_id
      WHERE cm.company_id = ? AND u.public_id = ?`,
    [companyId, userPublicId],
  );
  if (!m) throw new HttpError(404, 'NOT_FOUND', 'Utilisateur introuvable');
  return m;
}

export async function changeRole(auth, userPublicId, roleCode, ip) {
  assertCanAssign(auth.role, roleCode);
  return withTransaction(async (conn) => {
    const m = await findMember(conn, auth.companyId, userPublicId);
    if (m.user_id === auth.userId) throw new HttpError(422, 'SELF_CHANGE', 'Vous ne pouvez pas modifier votre propre rôle');
    assertCanManageTarget(auth.role, m.role);
    const role = await roleByCode(conn, roleCode);
    await conn.query('UPDATE company_members SET role_id = ? WHERE id = ?', [role.id, m.id]);
    await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'user.role_changed', entityType: 'user', entityId: m.user_id, ip, meta: { from: m.role, to: roleCode } });
  });
}

export async function setStatus(auth, userPublicId, status, ip) {
  return withTransaction(async (conn) => {
    const m = await findMember(conn, auth.companyId, userPublicId);
    if (m.user_id === auth.userId) throw new HttpError(422, 'SELF_CHANGE', 'Vous ne pouvez pas vous désactiver vous-même');
    assertCanManageTarget(auth.role, m.role);
    if (status === 'active' && m.status !== 'active') await assertLimit(conn, auth.companyId, 'users');
    await conn.query('UPDATE company_members SET status = ? WHERE id = ?', [status, m.id]);
    if (status === 'disabled') {
      await conn.query('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND company_id = ? AND revoked_at IS NULL', [new Date(), m.user_id, auth.companyId]);
    }
    await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: `user.${status === 'disabled' ? 'disabled' : 'enabled'}`, entityType: 'user', entityId: m.user_id, ip });
  });
}

export async function createInvitation(auth, { email, roleCode }, ip) {
  assertCanAssign(auth.role, roleCode);
  return withTransaction(async (conn) => {
    const role = await roleByCode(conn, roleCode);
    const [[member]] = await conn.query(
      `SELECT cm.status FROM company_members cm JOIN users u ON u.id = cm.user_id WHERE cm.company_id = ? AND u.email = ?`,
      [auth.companyId, email],
    );
    if (member?.status === 'active') throw new HttpError(409, 'ALREADY_MEMBER', 'Cette personne est déjà membre');

    await conn.query('UPDATE invitations SET revoked_at = ? WHERE company_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL', [new Date(), auth.companyId, email]);
    await assertLimit(conn, auth.companyId, 'users');
    const raw = randomToken();
    const publicId = newPublicId();
    const expires = new Date(Date.now() + 7 * 86_400_000);
    await conn.query(
      'INSERT INTO invitations (public_id, company_id, email, role_id, token_hash, invited_by, expires_at) VALUES (?,?,?,?,?,?,?)',
      [publicId, auth.companyId, email, role.id, sha256(raw), auth.userId, expires],
    );
    const [[company]] = await conn.query('SELECT name FROM companies WHERE id = ?', [auth.companyId]);
    await sendMail({
      to: email,
      subject: `Invitation à rejoindre ${company.name} sur MHFac`,
      text: `Vous êtes invité(e) à rejoindre ${company.name} sur MHFac.\nAcceptez l'invitation : ${clientUrl(`/accept-invitation?token=${raw}`)}\n(valable 7 jours)`,
    });
    await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'user.invited', entityType: 'invitation', entityId: publicId, ip, meta: { role: roleCode } });
    // Sans SMTP (mode console, hors production), on renvoie le lien pour pouvoir l'utiliser en developpement.
    const acceptUrl = env.MAIL_PROVIDER === 'console' && !env.isProd ? clientUrl(`/accept-invitation?token=${raw}`) : undefined;
    return { id: publicId, email, role: roleCode, expiresAt: expires, acceptUrl };
  });
}

export async function listInvitations(companyId) {
  const [rows] = await pool.query(
    `SELECT i.public_id, i.email, i.expires_at, i.created_at, r.code AS role FROM invitations i JOIN roles r ON r.id = i.role_id
      WHERE i.company_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`,
    [companyId, new Date()],
  );
  return rows.map((r) => ({ id: r.public_id, email: r.email, role: r.role, expiresAt: r.expires_at, createdAt: r.created_at }));
}

export async function revokeInvitation(auth, publicId, ip) {
  const [res] = await pool.query(
    'UPDATE invitations SET revoked_at = ? WHERE company_id = ? AND public_id = ? AND accepted_at IS NULL AND revoked_at IS NULL',
    [new Date(), auth.companyId, publicId],
  );
  if (!res.affectedRows) throw new HttpError(404, 'NOT_FOUND', 'Invitation introuvable');
  await audit(null, { companyId: auth.companyId, userId: auth.userId, action: 'user.invitation_revoked', entityType: 'invitation', entityId: publicId, ip });
}

export async function listRoles() {
  const [rows] = await pool.query('SELECT code, name FROM roles ORDER BY id');
  return rows;
}
