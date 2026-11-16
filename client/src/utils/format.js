// Montants : affichage uniquement. Les calculs de référence restent côté serveur (DECIMAL).
export const formatMoney = (value, currency = 'TND') =>
  value === null || value === undefined
    ? '—'
    : `${new Intl.NumberFormat('fr-TN', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(value))} ${currency}`;

export const formatDate = (iso) => (iso ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—');

export const cn = (...parts) => parts.filter(Boolean).join(' ');
export const ROLE_LABELS = {
  owner: 'Propriétaire', admin: 'Administrateur', accountant: 'Comptable', sales: 'Commercial',
  stock_manager: 'Gestionnaire de stock', read_only: 'Lecture seule',
};
