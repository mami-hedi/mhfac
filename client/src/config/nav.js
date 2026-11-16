import {
  LayoutDashboard, BarChart3, ShoppingCart, ShoppingBag, CreditCard, Landmark, Percent, Users, Truck,
  Tag, Boxes, FolderOpen, FileCheck2, Settings, ShieldCheck, Sparkles,
} from 'lucide-react';

// Source unique du menu ET des routes. `perm` : permission requise pour voir l'entrée ; `phase` : phase prévue.
// Les entrées dont le module n'existe pas encore affichent une page « en cours de développement ».
export const NAV = [
  { label: 'Général', items: [
    { label: 'Tableau de bord', path: '/', icon: LayoutDashboard, built: true },
    { label: 'Rapports et statistiques', path: '/reports', icon: BarChart3, perm: 'report.read', built: true },
  ] },
  { label: 'Commerce', items: [
    { label: 'Ventes', icon: ShoppingCart, children: [
      { label: 'Devis', path: '/sales/quotes', perm: 'quote.read', built: true },
      { label: 'Commandes client', path: '/sales/orders', perm: 'sales_order.read', built: true },
      { label: 'Bons de livraison', path: '/sales/delivery-notes', perm: 'delivery.read', built: true },
      { label: 'Factures', path: '/sales/invoices', perm: 'invoice.read', built: true },
      { label: 'Bons de sortie', path: '/sales/exit-vouchers', perm: 'stock.read', built: true },
      { label: 'Factures récurrentes', path: '/sales/recurring', perm: 'invoice.read', built: true },
      { label: 'Avoirs', path: '/sales/credit-notes', perm: 'credit_note.read', built: true },
      { label: 'Relances clients', path: '/sales/reminders', perm: 'payment.read', built: true },
      { label: 'Créances clients', path: '/sales/balances', perm: 'invoice.read', built: true },
      { label: 'Bons de retour', path: '/sales/returns', perm: 'sales_return.read', built: true },
      { label: 'Notes de débours', path: '/sales/expense-notes', perm: 'expense_note.read', built: true },
    ] },
    { label: 'Achats', icon: ShoppingBag, children: [
      { label: 'Bons de commande', path: '/purchases/orders', perm: 'purchase.read', built: true },
      { label: 'Bons de réception', path: '/purchases/receipts', perm: 'purchase_receipt.read', built: true },
      { label: "Factures d'achat", path: '/purchases/invoices', perm: 'purchase.read', built: true },
      { label: 'Scanner une facture', path: '/purchases/scan', perm: 'purchase.write', built: true },
      { label: 'Avoirs fournisseur', path: '/purchases/credit-notes', perm: 'purchase.read', built: true },
      { label: 'Règlements fournisseur', path: '/purchases/payments', perm: 'payment.read', built: true },
      { label: 'Soldes fournisseurs', path: '/purchases/balances', perm: 'purchase.read', built: true },
      { label: 'Retours fournisseur', path: '/purchases/returns', perm: 'purchase_return.read', built: true },
      { label: 'Notes de débours', path: '/purchases/expense-notes', perm: 'expense_note.read', built: true },
    ] },
    { label: 'Paiements', path: '/payments', icon: CreditCard, perm: 'payment.read', built: true },
    { label: 'Trésorerie', icon: Landmark, children: [
      { label: 'Comptes', path: '/treasury/accounts', perm: 'treasury.read', built: true },
      { label: 'Transactions', path: '/treasury/transactions', perm: 'treasury.read', built: true },
      { label: 'Chèques & traites', path: '/treasury/cheques', perm: 'treasury.read', built: true },
    ] },
    { label: 'Retenue à la source', icon: Percent, children: [
      { label: 'RS Ventes', path: '/withholdings/sales', perm: 'withholding.read', built: true },
      { label: 'RS Achats / Autres', path: '/withholdings/purchases', perm: 'withholding.read', built: true },
    ] },
  ] },
  { label: 'Données', items: [
    { label: 'Clients', path: '/clients', icon: Users, perm: 'client.read', built: true },
    { label: 'Fournisseurs', path: '/suppliers', icon: Truck, perm: 'supplier.read', built: true },
    { label: 'Articles', path: '/products', icon: Tag, perm: 'product.read', built: true },
    { label: 'Stock', icon: Boxes, children: [
      { label: 'Inventaire', path: '/stock/inventory', perm: 'stock.read', built: true },
      { label: 'Mouvements de stock', path: '/stock/movements', perm: 'stock.read', built: true },
      { label: "Bons d'entrée", path: '/stock/entries', perm: 'stock.read', built: true },
      { label: 'Bons de prélèvement', path: '/stock/withdrawals', perm: 'stock.read', built: true },
      { label: 'Bons de transfert', path: '/stock/transfers', perm: 'stock.read', built: true },
      { label: "Fiches d'inventaire", path: '/stock/sheets', perm: 'stock.read', built: true },
      { label: 'Entrepôts', path: '/stock/warehouses', perm: 'stock.read', built: true },
    ] },
    { label: 'Projets', path: '/projects', icon: FolderOpen, perm: 'project.read', built: true },
    { label: 'Facturation électronique', path: '/e-invoicing', icon: FileCheck2, perm: 'einvoice.read', built: false, soon: true },
  ] },
  { label: 'Administration', items: [
    { label: 'Utilisateurs et rôles', path: '/users', icon: ShieldCheck, perm: 'user.read', built: true },
    { label: 'Taux de TVA', path: '/settings/taxes', icon: Percent, perm: 'tax_rate.read', built: true },
    { label: 'Paramètres', path: '/settings', icon: Settings, perm: 'settings.read', built: true },
    { label: 'Abonnement', path: '/subscription', icon: Sparkles, perm: 'subscription.read', built: true },
  ] },
];

// Filtre le menu selon les permissions ; masque groupes et sous-menus vides.
export function visibleNav(can) {
  const ok = (i) => !i.perm || can(i.perm);
  return NAV.map((g) => ({
    ...g,
    items: g.items
      .map((i) => (i.children ? { ...i, children: i.children.filter(ok) } : i))
      .filter((i) => (i.children ? i.children.length > 0 : ok(i))),
  })).filter((g) => g.items.length > 0);
}

export const flatPages = () => NAV.flatMap((g) => g.items.flatMap((i) => (i.children ? i.children.map((c) => ({ ...c, group: i.label })) : [i])));

// Accès rapide « Nouveau » de la barre supérieure
export const QUICK_CREATE = [
  { label: 'Devis', path: '/sales/quotes/new', perm: 'quote.write' },
  { label: 'Facture', path: '/sales/invoices/new', perm: 'invoice.write' },
  { label: 'Bon de livraison', path: '/sales/delivery-notes', perm: 'delivery.write' },
  { label: 'Client', path: '/clients?new=1', perm: 'client.write' },
  { label: 'Article', path: '/products?new=1', perm: 'product.write' },
  { label: 'Paiement', path: '/payments?new=1', perm: 'payment.write' },
];
