// Express 4 ne capte pas les rejets de promesses : on les transmet au gestionnaire d'erreurs.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
