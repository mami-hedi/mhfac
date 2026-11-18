import { z } from 'zod';

// Matricule (immatriculation) d'un véhicule : texte libre court (ex. « 123 TUN 4567 », « 123 تونس 4567 »), mis en majuscules,
// sans caractères de contrôle. Vide = pas de véhicule renseigné.
export const vehiclePlate = z.preprocess(
  (v) => { if (v == null) return null; const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase(); return s === '' ? null : s; },
  z.string().max(20, 'Matricule : 20 caractères maximum').nullable().optional(),
);
