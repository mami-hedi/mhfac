// Offres de la page d'accueil : lues depuis l'API publique (source unique : l'administration de la plateforme).
// Si l'API est injoignable, on affiche le repli statique de LandingPage (jamais une page vide).
import { useEffect, useState } from 'react';
import { api } from '../../services/api.js';

const n = (v) => Number(v).toLocaleString('fr-FR');
const money = (v, cur) => `${Number(v).toLocaleString('fr-FR', { minimumFractionDigits: Number(v) % 1 ? 3 : 0, maximumFractionDigits: 3 })} ${cur}`;
const cap = (v, one, many) => (v === null || v === undefined ? null : `${n(v)} ${v > 1 ? many : one}`);

const SUBTITLES = { decouverte: 'Pour essayer MHFac', auto_entrepreneur: 'Pour une activité individuelle', pro: 'L\'offre standard MHFac', business: 'Pour une entreprise multi-utilisateurs' };

export function toDisplayPlan(p) {
  const l = p.limits ?? {}; const f = p.features ?? {};
  const unl = (v, label) => (v === null || v === undefined ? `${label} illimité${label.endsWith('s') ? 's' : ''}` : null);
  const rows = [
    [cap(l.users, 'utilisateur', 'utilisateurs') ?? 'Utilisateurs illimités', 1],
    [cap(l.invoicesPerMonth, 'facture / mois', 'factures / mois') ?? 'Factures illimitées', 1],
    [cap(l.warehouses, 'entrepôt', 'entrepôts') ?? 'Entrepôts illimités', 1],
    [f.purchaseScan ? (cap(l.scansPerMonth, 'scan de factures / mois', 'scans de factures / mois') ?? 'Scans de factures illimités') : 'Scan de factures fournisseur', f.purchaseScan ? 1 : 0],
    [f.reportsExport ? (l.exportsPerMonth == null ? 'Exports illimités (CSV, Excel, PDF)' : 'Export des rapports (CSV, Excel, PDF)') : 'Export des rapports', f.reportsExport ? 1 : 0],
    ['Facturation électronique (bientôt)', 0],
  ];
  void unl;
  return {
    code: p.code, n: p.name, s: p.description && !SUBTITLES[p.code] ? p.description : (SUBTITLES[p.code] ?? p.description ?? ''),
    p: p.priceMonthly == null ? 'Sur demande' : String(Number(p.priceMonthly).toLocaleString('fr-FR', { maximumFractionDigits: 3 })), priced: p.priceMonthly != null,
    y: p.priceYearly == null ? null : `${money(p.priceYearly, p.currency)} / an${p.yearlyMonthsFree > 0 ? ` (${p.yearlyMonthsFree.toLocaleString('fr-FR')} mois offerts)` : ''}`,
    cur: p.currency, hot: p.code === 'pro', f: rows,
  };
}

export function usePublicPlans() {
  const [plans, setPlans] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/public/plans').then((r) => { if (alive && Array.isArray(r.data.data) && r.data.data.length) setPlans(r.data.data.map(toDisplayPlan)); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return plans;
}
