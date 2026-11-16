import { z } from 'zod';

export const PAGE_SIZE = 15; // nombre de lignes par page, identique dans tous les modules
export const EXPORT_MAX = 5000; // plafond d'un export CSV

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE),
  q: z.string().trim().max(100).optional(),
  sort: z.string().max(30).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  status: z.enum(['active', 'archived']).optional(),
});

export const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

// Tri : seules les colonnes de la liste blanche sont acceptees (jamais de SQL venant du client).
export function orderBy(sort, order, allowed, fallback) {
  const col = allowed[sort] ?? allowed[fallback];
  return `${col} ${order === 'desc' ? 'DESC' : 'ASC'}, ${allowed.id ?? 'id'} ASC`;
}
