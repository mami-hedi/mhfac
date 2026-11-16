import { seedDefaultTaxRates } from '../tax-rates/tax-rates.routes.js';
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit.js';
import { newPublicId } from '../../core/ids.js';
import { clientUrl, sendMail } from '../../core/mailer.js';
import { DUMMY_HASH, hashPassword, passwordSchema, verifyPassword } from '../../core/password.js';
import { randomToken, sha256, signAccessToken } from '../../core/tokens.js';
import { HttpError } from '../../utils/httpError.js';

import { ensureSubscription } from '../../core/plan.js';
const DAY = 86_400_000;
const addMs = (ms) => new Date(Date.now() + ms);

export const toUserDto = (u) => ({
  id: u.public_id, email: u.email, fullName: u.full_name, locale: u.locale, emailVerified: !!u.email_verified_at, isPlatformAdmin: !!u.is_platform_admin,
});
export const toCompanyDto = (c) => ({
  id: c.public_id, name: c.name, legalName: c.legal_name, taxId: c.tax_id,
  currency: c.currency, timezone: c.timezone, locale: c.locale,
});

async function roleId(conn, code) {
  const [[r]] = await conn.query('SELECT id FROM roles WHERE code = ?', [code]);
  return r.id;
}

async function createRefreshToken(conn, { userId, companyId, familyId = newPublicId(), ctx }) {
  const raw = randomToken();
  const [res] = await conn.query(
    `INSERT INTO refresh_tokens (user_id, company_id, token_hash, family_id, expires_at, user_agent, ip)
     VALUES (?,?,?,?,?,?,?)`,
    [userId, companyId, sha256(raw), familyId, addMs(env.JWT_REFRESH_TTL_DAYS * DAY), (ctx.userAgent ?? '').slice(0, 255), ctx.ip ?? null],
  );
  return { raw, id: res.insertId, familyId };
}

async function buildSession(conn, user, company, ctx, familyId) {
  const [[member]] = await conn.query(
    'SELECT r.code FROM company_members cm JOIN roles r ON r.id = cm.role_id WHERE cm.user_id = ? AND cm.company_id = ?',
    [user.id, company.id],
  );
  const refresh = await createRefreshToken(conn, { userId: user.id, companyId: company.id, familyId, ctx });
  return {
    accessToken: signAccessToken({ userId: user.id, companyId: company.id }),
    refreshToken: refresh.raw,
    user: toUserDto(user),
    company: toCompanyDto(company),
    role: member.code,
  };
}

async function sendVerifyEmail(conn, user) {
  const raw = randomToken();
  await conn.query(
    "INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES (?, 'email_verify', ?, ?)",
    [user.id, sha256(raw), addMs(2 * DAY)],
  );
  await sendMail({
    to: user.email,
    subject: 'MHFac : confirmez votre adresse e-mail',
    text: `Bonjour ${user.full_name},\n\nConfirmez votre adresse : ${clientUrl(`/verify-email?token=${raw}`)}\n(lien valable 48 h)`,
  });
}

export async function registerCompany(input, ctx) {
  const [[exists]] = await pool.query('SELECT id FROM users WHERE email = ?', [input.email]);
  if (exists) throw new HttpError(409, 'EMAIL_TAKEN', 'Cette adresse e-mail est déjà utilisée');

  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (conn) => {
    const [c] = await conn.query('INSERT INTO companies (public_id, name, tax_id) VALUES (?,?,?)', [newPublicId(), input.companyName, input.taxId ?? null]);
    await conn.query('INSERT INTO company_settings (company_id, settings) VALUES (?, ?)', [c.insertId, '{}']);
    const [u] = await conn.query('INSERT INTO users (public_id, email, password_hash, full_name) VALUES (?,?,?,?)', [newPublicId(), input.email, passwordHash, input.fullName]);
    await conn.query('INSERT INTO company_members (company_id, user_id, role_id) VALUES (?,?,?)', [c.insertId, u.insertId, await roleId(conn, 'owner')]);
    await seedDefaultTaxRates(conn, c.insertId);
    await ensureSubscription(conn, c.insertId);
    await audit(conn, { companyId: c.insertId, userId: u.insertId, action: 'company.registered', entityType: 'company', entityId: c.insertId, ip: ctx.ip });

    const [[user]] = await conn.query('SELECT * FROM users WHERE id = ?', [u.insertId]);
    const [[company]] = await conn.query('SELECT * FROM companies WHERE id = ?', [c.insertId]);
    await sendVerifyEmail(conn, user);
    return buildSession(conn, user, company, ctx);
  });
}

export async function login({ email, password, companyId }, ctx) {
  const [[user]] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    await verifyPassword(password, DUMMY_HASH); // meme duree de reponse qu'un vrai compte
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'E-mail ou mot de passe incorrect');
  }
  if (user.locked_until && user.locked_until > new Date()) {
    await audit(null, { userId: user.id, action: 'auth.login_blocked', ip: ctx.ip });
    throw new HttpError(429, 'ACCOUNT_LOCKED', 'Trop de tentatives. Réessayez plus tard.');
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const failures = user.failed_login_count + 1;
    const lock = failures >= env.LOGIN_MAX_FAILURES;
    await pool.query('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?', [
      lock ? 0 : failures, lock ? addMs(env.LOGIN_LOCK_MINUTES * 60_000) : null, user.id,
    ]);
    await audit(null, { userId: user.id, action: lock ? 'auth.account_locked' : 'auth.login_failed', ip: ctx.ip });
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'E-mail ou mot de passe incorrect');
  }
  if (user.status !== 'active') throw new HttpError(403, 'ACCOUNT_DISABLED', 'Compte désactivé');

  const [companies] = await pool.query(
    `SELECT c.* FROM company_members cm JOIN companies c ON c.id = cm.company_id
      WHERE cm.user_id = ? AND cm.status = 'active' AND c.status = 'active' ORDER BY cm.created_at`,
    [user.id],
  );
  const company = companyId ? companies.find((c) => c.public_id === companyId) : companies[0];
  if (!company) throw new HttpError(403, 'NO_COMPANY', 'Aucune entreprise accessible pour ce compte');

  return withTransaction(async (conn) => {
    await conn.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [new Date(), user.id]);
    await audit(conn, { companyId: company.id, userId: user.id, action: 'auth.login', ip: ctx.ip });
    return buildSession(conn, user, company, ctx);
  });
}

// Rotation : chaque refresh remplace le jeton. Un jeton deja utilise (revoque) qui revient = vol probable
// -> toute la famille est revoquee.
export async function refresh(rawToken, ctx) {
  if (!rawToken) throw new HttpError(401, 'UNAUTHENTICATED', 'Session absente');
  const outcome = await withTransaction(async (conn) => {
    const [[row]] = await conn.query('SELECT * FROM refresh_tokens WHERE token_hash = ? FOR UPDATE', [sha256(rawToken)]);
    if (!row) return { error: 'INVALID' };
    // Jeton deja remplace : si c'est dans la fenetre de grace (deux onglets ou requetes simultanees), on delivre
    // simplement un nouveau jeton de la meme famille. Au-dela, c'est une reutilisation suspecte : famille revoquee.
    const graceMs = env.REFRESH_REUSE_GRACE_SECONDS * 1000;
    const benignRace = !!row.revoked_at && graceMs > 0 && !!row.replaced_by_id && Date.now() - row.revoked_at.getTime() < graceMs;
    if (row.revoked_at && !benignRace) {
      await conn.query('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', [new Date(), row.family_id]);
      await audit(conn, { companyId: row.company_id, userId: row.user_id, action: 'auth.refresh_reuse_detected', ip: ctx.ip });
      return { error: 'REUSED' };
    }
    if (row.expires_at < new Date()) return { error: 'EXPIRED' };

    const [[user]] = await conn.query('SELECT * FROM users WHERE id = ?', [row.user_id]);
    const [[company]] = await conn.query('SELECT * FROM companies WHERE id = ?', [row.company_id]);
    const [[member]] = await conn.query('SELECT status FROM company_members WHERE user_id = ? AND company_id = ?', [row.user_id, row.company_id]);
    if (user.status !== 'active' || company.status !== 'active' || member?.status !== 'active') return { error: 'DISABLED' };

    const session = await buildSession(conn, user, company, ctx, row.family_id);
    const [[newRow]] = await conn.query('SELECT id FROM refresh_tokens WHERE token_hash = ?', [sha256(session.refreshToken)]);
    if (!row.revoked_at) {
      await conn.query('UPDATE refresh_tokens SET revoked_at = ?, replaced_by_id = ? WHERE id = ?', [new Date(), newRow.id, row.id]);
    }
    return { session };
  });
  if (outcome.error) throw new HttpError(401, 'INVALID_SESSION', 'Session expirée, reconnectez-vous');
  return outcome.session;
}

export async function logout(rawToken) {
  if (!rawToken) return;
  await pool.query('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [new Date(), sha256(rawToken)]);
}

export async function switchCompany(auth, companyPublicId, ctx, currentRaw) {
  const [[company]] = await pool.query(
    `SELECT c.* FROM company_members cm JOIN companies c ON c.id = cm.company_id
      WHERE cm.user_id = ? AND c.public_id = ? AND cm.status = 'active' AND c.status = 'active'`,
    [auth.userId, companyPublicId],
  );
  if (!company) throw new HttpError(404, 'NOT_FOUND', 'Entreprise introuvable');
  const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [auth.userId]);
  await logout(currentRaw);
  return withTransaction((conn) => buildSession(conn, user, company, ctx));
}

export async function forgotPassword(email) {
  const [[user]] = await pool.query("SELECT * FROM users WHERE email = ? AND status = 'active'", [email]);
  if (!user) return; // meme reponse publique dans tous les cas : pas d'enumeration de comptes
  const raw = randomToken();
  await pool.query(
    "INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES (?, 'password_reset', ?, ?)",
    [user.id, sha256(raw), addMs(60 * 60_000)],
  );
  // Envoi non bloquant : la réponse ne dépend pas de la lenteur du serveur SMTP (sinon le délai révèle si le compte existe).
  sendMail({
    to: user.email,
    subject: 'MHFac : réinitialisation du mot de passe',
    text: `Pour choisir un nouveau mot de passe : ${clientUrl(`/reset-password?token=${raw}`)}\n(lien valable 1 h, ignorez ce message si vous n'êtes pas à l'origine de la demande)`,
  }).catch((e) => console.error(JSON.stringify({ level: 'error', msg: `envoi e-mail de réinitialisation : ${e.message}` })));
}

export async function resetPassword({ token, password }, ctx) {
  const hash = await hashPassword(password);
  await withTransaction(async (conn) => {
    const [[t]] = await conn.query(
      "SELECT * FROM email_tokens WHERE token_hash = ? AND type = 'password_reset' AND used_at IS NULL AND expires_at > ? FOR UPDATE",
      [sha256(token), new Date()],
    );
    if (!t) throw new HttpError(400, 'INVALID_TOKEN', 'Lien invalide ou expiré');
    await conn.query('UPDATE email_tokens SET used_at = ? WHERE id = ?', [new Date(), t.id]);
    await conn.query('UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?', [hash, t.user_id]);
    await conn.query('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [new Date(), t.user_id]);
    await audit(conn, { userId: t.user_id, action: 'auth.password_reset', ip: ctx.ip });
  });
}

export async function verifyEmail(token) {
  const [res] = await pool.query(
    `UPDATE email_tokens t JOIN users u ON u.id = t.user_id
        SET t.used_at = ?, u.email_verified_at = COALESCE(u.email_verified_at, ?)
      WHERE t.token_hash = ? AND t.type = 'email_verify' AND t.used_at IS NULL AND t.expires_at > ?`,
    [new Date(), new Date(), sha256(token), new Date()],
  );
  if (!res.affectedRows) throw new HttpError(400, 'INVALID_TOKEN', 'Lien invalide ou expiré');
}

export async function changePassword(auth, { currentPassword, newPassword }, ctx) {
  const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [auth.userId]);
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw new HttpError(400, 'WRONG_PASSWORD', 'Mot de passe actuel incorrect');
  }
  const hash = await hashPassword(newPassword);
  await withTransaction(async (conn) => {
    await conn.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
    await conn.query('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [new Date(), user.id]);
    await audit(conn, { companyId: auth.companyId, userId: user.id, action: 'auth.password_changed', ip: ctx.ip });
  });
}

export async function acceptInvitation({ token, fullName, password }, ctx) {
  return withTransaction(async (conn) => {
    const [[inv]] = await conn.query(
      'SELECT * FROM invitations WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? FOR UPDATE',
      [sha256(token), new Date()],
    );
    if (!inv) throw new HttpError(400, 'INVALID_TOKEN', 'Invitation invalide ou expirée');

    let [[user]] = await conn.query('SELECT * FROM users WHERE email = ?', [inv.email]);
    if (user) {
      if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Mot de passe incorrect');
      if (user.status !== 'active') throw new HttpError(403, 'ACCOUNT_DISABLED', 'Compte désactivé');
    } else {
      if (!fullName) throw new HttpError(400, 'VALIDATION_ERROR', 'Nom complet requis');
      const parsed = passwordSchema.safeParse(password);
      if (!parsed.success) throw parsed.error;
      const [u] = await conn.query(
        'INSERT INTO users (public_id, email, password_hash, full_name, email_verified_at) VALUES (?,?,?,?,?)',
        [newPublicId(), inv.email, await hashPassword(password), fullName, new Date()], // l'invitation prouve le controle de l'e-mail
      );
      [[user]] = await conn.query('SELECT * FROM users WHERE id = ?', [u.insertId]);
    }

    const [[existing]] = await conn.query('SELECT status FROM company_members WHERE company_id = ? AND user_id = ?', [inv.company_id, user.id]);
    if (existing?.status === 'active') throw new HttpError(409, 'ALREADY_MEMBER', 'Déjà membre de cette entreprise');
    if (existing) {
      await conn.query("UPDATE company_members SET role_id = ?, status = 'active' WHERE company_id = ? AND user_id = ?", [inv.role_id, inv.company_id, user.id]);
    } else {
      await conn.query('INSERT INTO company_members (company_id, user_id, role_id) VALUES (?,?,?)', [inv.company_id, user.id, inv.role_id]);
    }
    await conn.query('UPDATE invitations SET accepted_at = ? WHERE id = ?', [new Date(), inv.id]);
    await audit(conn, { companyId: inv.company_id, userId: user.id, action: 'user.invitation_accepted', entityType: 'invitation', entityId: inv.id, ip: ctx.ip });

    const [[company]] = await conn.query('SELECT * FROM companies WHERE id = ?', [inv.company_id]);
    return buildSession(conn, user, company, ctx);
  });
}

export async function me(auth) {
  const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [auth.userId]);
  const [[company]] = await pool.query('SELECT * FROM companies WHERE id = ?', [auth.companyId]);
  const [memberships] = await pool.query(
    `SELECT c.public_id, c.name, r.code AS role FROM company_members cm
       JOIN companies c ON c.id = cm.company_id JOIN roles r ON r.id = cm.role_id
      WHERE cm.user_id = ? AND cm.status = 'active' AND c.status = 'active' ORDER BY cm.created_at`,
    [auth.userId],
  );
  return {
    user: toUserDto(user),
    company: toCompanyDto(company),
    role: auth.role,
    permissions: [...auth.permissions].sort(),
    memberships: memberships.map((m) => ({ companyId: m.public_id, name: m.name, role: m.role })),
  };
}

export async function updateProfile(auth, { fullName, locale }) {
  const sets = []; const vals = [];
  if (fullName !== undefined) { sets.push('full_name = ?'); vals.push(fullName); }
  if (locale !== undefined) { sets.push('locale = ?'); vals.push(locale); }
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...vals, auth.userId]);
}
