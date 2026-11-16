// Nom de fichier sûr à partir d'un numéro de document (un numéro peut contenir « / » : FAC/2026/001).
export const fileSafe = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
