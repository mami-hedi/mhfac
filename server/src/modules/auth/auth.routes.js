import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './auth.schemas.js';
import * as svc from './auth.service.js';

const router = Router();
const COOKIE = 'mhfac_rt';
const cookieOpts = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'strict',
  path: '/api/v1/auth', // le cookie n'est envoye qu'aux routes d'auth
  maxAge: env.JWT_REFRESH_TTL_DAYS * 86_400_000,
};
const ctxOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// Reponse de session : jeton d'acces dans le corps, jeton de rafraichissement en cookie httpOnly.
function sendSession(res, status, session) {
  const { refreshToken, ...data } = session;
  res.cookie(COOKIE, refreshToken, cookieOpts);
  res.status(status).json({ data });
}

// Limite STRICTE uniquement sur les routes qui testent des identifiants ou envoient un e-mail (anti force brute / anti spam).
// /refresh, /me, /logout et /switch-company restent sous la limite générale de l'API : un utilisateur légitime qui recharge ses pages
// ne doit jamais être bloqué (et un blocage de /refresh déconnecterait l'utilisateur).
const tooMany = { error: { code: 'RATE_LIMITED', message: 'Trop de requêtes, réessayez plus tard' } };
const strict = rateLimit({ windowMs: 15 * 60_000, limit: env.AUTH_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false, message: tooMany });
// « Mot de passe oublié » : au plus 3 e-mails par heure et par adresse (empêche d'inonder la boîte d'une victime), en plus de la limite par IP.
const perEmail = rateLimit({
  windowMs: 60 * 60_000, limit: 3, standardHeaders: false, legacyHeaders: false, message: tooMany,
  keyGenerator: (req) => `fp:${String(req.body?.email ?? '').toLowerCase().slice(0, 190)}`,
});

router.post('/register-company', strict, validate({ body: s.registerSchema }),
  asyncHandler(async (req, res) => sendSession(res, 201, await svc.registerCompany(req.body, ctxOf(req)))));

router.post('/login', strict, validate({ body: s.loginSchema }),
  asyncHandler(async (req, res) => sendSession(res, 200, await svc.login(req.body, ctxOf(req)))));

router.post('/refresh', asyncHandler(async (req, res) => {
  try {
    sendSession(res, 200, await svc.refresh(req.cookies?.[COOKIE], ctxOf(req)));
  } catch (err) {
    res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
    throw err;
  }
}));

router.post('/logout', asyncHandler(async (req, res) => {
  await svc.logout(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
  res.status(204).end();
}));

router.post('/switch-company', authenticate, validate({ body: s.switchCompanySchema }),
  asyncHandler(async (req, res) =>
    sendSession(res, 200, await svc.switchCompany(req.auth, req.body.companyId, ctxOf(req), req.cookies?.[COOKIE]))));

router.post('/forgot-password', strict, validate({ body: s.emailOnlySchema }), perEmail, asyncHandler(async (req, res) => {
  await svc.forgotPassword(req.body.email);
  res.status(202).json({ data: { message: 'Si le compte existe, un e-mail a été envoyé.' } });
}));

router.post('/reset-password', strict, validate({ body: s.resetSchema }), asyncHandler(async (req, res) => {
  await svc.resetPassword(req.body, ctxOf(req));
  res.status(204).end();
}));

// Renvoi du lien de confirmation : au plus 3 par heure et par utilisateur connecté.
const perUserVerify = rateLimit({
  windowMs: 60 * 60_000, limit: 3, standardHeaders: false, legacyHeaders: false, message: tooMany,
  keyGenerator: (req) => `rv:${req.auth?.userId ?? req.ip}`,
});
router.post('/resend-verification', authenticate, perUserVerify, asyncHandler(async (req, res) => {
  res.json({ data: await svc.resendVerification(req.auth) });
}));

router.post('/verify-email', strict, validate({ body: s.tokenSchema }), asyncHandler(async (req, res) => {
  await svc.verifyEmail(req.body.token);
  res.status(204).end();
}));

router.post('/accept-invitation', strict, validate({ body: s.acceptInvitationSchema }),
  asyncHandler(async (req, res) => sendSession(res, 201, await svc.acceptInvitation(req.body, ctxOf(req)))));

router.post('/change-password', strict, authenticate, validate({ body: s.changePasswordSchema }), asyncHandler(async (req, res) => {
  await svc.changePassword(req.auth, req.body, ctxOf(req));
  res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
  res.status(204).end();
}));

router.patch('/me', authenticate, validate({ body: s.profileSchema }), asyncHandler(async (req, res) => {
  await svc.updateProfile(req.auth, req.body);
  res.json({ data: await svc.me(req.auth) });
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => res.json({ data: await svc.me(req.auth) })));

export default router;
