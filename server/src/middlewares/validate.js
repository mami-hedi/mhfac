import { ZodError } from 'zod';

// Zod 4 renvoie parfois des clés « undefined » pour les champs optionnels absents (prétraitements, partial()). On les retire pour que
// « champ absent » reste distinct de « champ à effacer (null) » dans tous les PATCH.
export function stripUndefined(v) {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = stripUndefined(x); return out;
  }
  return v;
}

// validate({ body, query, params }) : valide avec Zod et remplace par les valeurs nettoyees.
export const validate = (schemas) => (req, _res, next) => {
  try {
    for (const key of ['params', 'query', 'body']) {
      if (!schemas[key]) continue;
      const raw = req[key]; let out = stripUndefined(schemas[key].parse(raw));
      // Schéma de modification (PATCH) : Zod 4 applique les valeurs par défaut aux champs optionnels ABSENTS (partial()), ce qui
      // écraserait silencieusement des données existantes (ex. délai de paiement remis à 0). On ne garde donc que les champs réellement envoyés.
      if (schemas[key].__patch && raw && typeof raw === 'object' && !Array.isArray(raw)) {
        out = Object.fromEntries(Object.entries(out).filter(([k]) => Object.hasOwn(raw, k)));
        if (!Object.keys(out).length) throw new ZodError([{ code: 'custom', path: [], message: 'Aucune modification', input: raw }]);
      }
      req[key] = out;
    }
    next();
  } catch (err) {
    next(err);
  }
};

/** Marque un schéma comme « modification partielle » (PATCH) : voir validate(). */
export const asPatch = (schema) => Object.assign(schema, { __patch: true });
