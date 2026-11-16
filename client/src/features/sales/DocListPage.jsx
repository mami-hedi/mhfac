import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileText, Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { Pagination } from '../masterdata/shared.jsx';
import ListFilters, { PAGE_SIZE, useDebouncedJson, useListFilters } from '../../components/ListFilters.jsx';
import { DELIVERY_STATUS, INVOICE_TYPE, INVOICING_STATUS, StatusBadge, fmtDate, fmtMoney } from './shared.jsx';

export const CFG = {
  quote: { api: '/quotes', base: '/sales/quotes', perm: 'quote', title: 'Devis', one: 'devis', newLabel: 'Nouveau devis', dateLabel: 'Validité', dateKey: 'validUntil',
    statuses: [['', 'Tous les statuts'], ['draft', 'Brouillon'], ['sent', 'Envoyé'], ['accepted', 'Accepté'], ['refused', 'Refusé'], ['expired', 'Expiré'], ['converted', 'Converti']], subtitle: 'Proposez vos offres, suivez leur acceptation et convertissez-les en factures.' },
  sales_order: { api: '/orders', base: '/sales/orders', perm: 'sales_order', title: 'Commandes client', one: 'commande', newLabel: 'Nouvelle commande', dateLabel: 'Livraison souhaitée', dateKey: 'expectedDate',
    statuses: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['confirmed', 'Confirmées'], ['cancelled', 'Annulées']], subtitle: 'Confirmez les commandes, livrez-les (totalement ou partiellement) puis facturez : complète, par livraison ou avec acompte.' },
  invoice: { api: '/invoices', base: '/sales/invoices', perm: 'invoice', title: 'Factures', one: 'facture', newLabel: 'Nouvelle facture', dateLabel: 'Échéance', dateKey: 'dueDate',
    statuses: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['issued', 'Émises'], ['cancelled', 'Annulées']], subtitle: 'Les factures émises sont numérotées, figées et ne se corrigent que par avoir.' },
  credit_note: { api: '/credit-notes', base: '/sales/credit-notes', perm: 'credit_note', title: 'Avoirs', one: 'avoir', dateLabel: 'Date', dateKey: 'issueDate',
    statuses: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['issued', 'Émis']], subtitle: 'Les avoirs corrigent ou annulent tout ou partie d\'une facture émise. Créez-les depuis la facture concernée.' },
};

// Filtres avancés + export CSV branchés côté serveur sur tous les documents de vente
const FILTERABLE = { quote: true, sales_order: true, invoice: true, credit_note: true };

export default function DocListPage({ kind }) {
  const cfg = CFG[kind]; const { can } = useAuth(); const navigate = useNavigate();
  const fields = [
    { key: 'clientId', label: 'Client', type: 'entity', path: '/clients', placeholder: 'Sélectionner un client' },
    ...(FILTERABLE[kind] ? [{ key: 'from', label: 'Date de début', type: 'date' }, { key: 'to', label: 'Date de fin', type: 'date' }] : []),
    { key: 'status', label: 'Statut', type: 'select', options: cfg.statuses },
    ...(kind === 'invoice' ? [{ key: 'paymentStatus', label: 'Règlement', type: 'select', options: [['', 'Tous'], ['unpaid', 'Impayées'], ['partial', 'Partiellement payées'], ['paid', 'Payées'], ['overdue', 'En retard']] }] : []),
    { key: 'q', label: 'Recherche avancée', type: 'search', advanced: true, placeholder: FILTERABLE[kind] ? 'N°, client, désignation, notes…' : 'Numéro ou client…' },
    ...(FILTERABLE[kind] ? [
      { key: 'minAmount', label: 'Montant minimum (TTC)', type: 'money', advanced: true }, { key: 'maxAmount', label: 'Montant maximum (TTC)', type: 'money', advanced: true },
      { key: 'projectId', label: 'Projet', type: 'entity', path: '/projects', placeholder: 'Sélectionner un projet', advanced: true, perm: 'project.read' },
      { key: 'productId', label: 'Produit', type: 'entity', path: '/products', placeholder: 'Sélectionner un produit', advanced: true, perm: 'product.read' }] : []),
  ];
  const filters = useListFilters(fields.map((x) => x.key)); const { page, params } = filters;
  const [state, setState] = useState({ loading: true });
  const debounced = useDebouncedJson(params);
  const load = useCallback(async () => {
    try {
      const r = await api.get(cfg.api, { params: { ...JSON.parse(debounced), page, limit: PAGE_SIZE } });
      setState({ rows: r.data.data, meta: r.data.meta });
    } catch (e) { setState({ error: errorMessage(e) }); }
  }, [cfg.api, debounced, page]);
  useEffect(() => { load(); }, [load]);
  const canCreate = kind !== 'credit_note' && can(`${cfg.perm}.write`);

  return (
    <>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle} actions={canCreate && <Button onClick={() => navigate(`${cfg.base}/new`)}><Plus size={16} aria-hidden /> {cfg.newLabel}</Button>} />
      <Card>
        <ListFilters fields={fields} filters={filters} exportPath={FILTERABLE[kind] ? `${cfg.api}/export` : null} exportName={`${cfg.api.slice(1)}.csv`} onError={(t) => setState((s) => ({ ...s, exportError: t }))} />
        {state.exportError && <div className="px-4 pt-3"><Alert tone="error" onClose={() => setState((s) => ({ ...s, exportError: '' }))}>{state.exportError}</Alert></div>}
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={FileText} title={filters.active ? 'Aucun résultat' : `Aucun ${cfg.one} pour l'instant`} action={canCreate && !filters.active && <Button onClick={() => navigate(`${cfg.base}/new`)}><Plus size={16} aria-hidden /> {cfg.newLabel}</Button>}>
            {kind === 'credit_note' ? 'Ouvrez une facture émise puis choisissez « Créer un avoir ».' : 'Créez votre premier document : les totaux sont calculés par le serveur.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Numéro</th><th className="px-4 py-3">Client</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">{cfg.dateLabel}</th><th className="px-4 py-3 text-right">Total TTC</th><th className="px-4 py-3">Statut</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {state.rows.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`${cfg.base}/${d.id}`}>{d.number ?? 'Brouillon'}</Link></td>
                    <td className="px-4 py-3 font-medium text-slate-900">{d.clientName}</td>
                    <td className="px-4 py-3">{fmtDate(d.issueDate)}</td>
                    <td className="px-4 py-3">{fmtDate(d[cfg.dateKey])}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(d.totalTtc, d.currency)}</td>
                    <td className="px-4 py-3"><span className="inline-flex flex-wrap gap-1"><StatusBadge kind={kind} doc={d} />{kind === 'invoice' && INVOICE_TYPE[d.invoiceType] && <Badge tone="blue">{d.invoiceType === 'deposit' ? 'Acompte' : 'Solde'}</Badge>}{kind === 'sales_order' && d.status === 'confirmed' && <><Badge tone={DELIVERY_STATUS[d.deliveryStatus][1]}>{DELIVERY_STATUS[d.deliveryStatus][0]}</Badge><Badge tone={INVOICING_STATUS[d.invoicingStatus][1]}>{INVOICING_STATUS[d.invoicingStatus][0]}</Badge></>}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination meta={state.meta} onPage={(p) => filters.set({ page: p })} />
      </Card>
    </>
  );
}
