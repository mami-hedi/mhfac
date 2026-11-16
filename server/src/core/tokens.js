import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(48).toString('base64url');

// Jeton d'acces : court, porte userId + companyId. Les permissions sont relues en base a chaque requete.
export function signAccessToken({ userId, companyId }) {
  return jwt.sign({ cid: companyId }, env.JWT_ACCESS_SECRET, {
    subject: String(userId),
    expiresIn: env.JWT_ACCESS_TTL,
    algorithm: 'HS256',
    issuer: 'mhfac',
  });
}

export function verifyAccessToken(token) {
  const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'mhfac' });
  return { userId: Number(p.sub), companyId: Number(p.cid) };
}
