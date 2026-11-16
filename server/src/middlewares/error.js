import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

export function notFound(req, _res, next) {
  next(new HttpError(404, 'NOT_FOUND', `Route introuvable : ${req.method} ${req.originalUrl}`));
}

// Format d'erreur unique : { error: { code, message, details } }
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Donnees invalides', details: err.flatten() },
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  // Erreurs du lecteur de requêtes (JSON invalide, corps trop gros, encodage) : erreurs du CLIENT, pas du serveur
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Corps de requête JSON invalide' } });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Requête trop volumineuse' } });
  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') return res.status(415).json({ error: { code: 'UNSUPPORTED_ENCODING', message: 'Encodage non pris en charge' } });
  if (err.type === 'request.aborted' || err.type === 'request.size.invalid') return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Requête invalide' } });
  // Erreurs MySQL previsibles -> reponses metier (jamais le message SQL brut)
  if (err.errno === 1062) {
    const key = String(err.sqlMessage ?? '');
    const msg = key.includes('uq_products_sku') ? 'Ce SKU existe déjà' : key.includes('uq_tax_name') ? 'Un taux portant ce nom existe déjà' : key.includes('uq_cat_name') ? 'Une catégorie portant ce nom existe déjà' : 'Cette valeur existe déjà';
    return res.status(409).json({ error: { code: 'DUPLICATE', message: msg } });
  }
  if (err.errno === 1451) {
    return res.status(409).json({ error: { code: 'IN_USE', message: 'Élément utilisé ailleurs : archivez-le plutôt que de le supprimer' } });
  }
  console.error(JSON.stringify({ level: 'error', msg: err.message, stack: env.isProd ? undefined : err.stack }));
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: env.isProd ? 'Erreur interne' : err.message },
  });
}
