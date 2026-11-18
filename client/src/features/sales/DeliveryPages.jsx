import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, CheckCircle2, Download, History, Mail, Receipt, Search, Trash2, Truck } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { Pagination, downloadCsv, useDebounced } from '../masterdata/shared.jsx';
import ListFilters, { PAGE_SIZE, useDebouncedJson, useListFilters } from '../../components/ListFilters.jsx';
import { BL_STATUS, StatusBadge, fmtDate } from './shared.jsx';
import { EmailModal } from './DocViewPage.jsx';
import { ReturnModal } from '../stock/ReturnPages.jsx';

export function DeliveryListPage() {
  const fields = [
    { key: 'clientId', label: 'Client', type: 'entity', path: '/clients', placeholder: 'Sélectionner un client' },
    { key: 'from', label: 'Date de début', type: 'date' }, { key: 'to', label: 'Date de fin', type: 'date' },
    { key: 'status', label: 'Statut', type: 'select', options: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['validated', 'Validés'], ['cancelled', 'Annulés']] },
    { key: 'q', label: 'Recherche avancée', type: 'search', advanced: true, placeholder: 'N°, client, commande, facture, désignation, notes…' },
    { key: 'productId', label: 'Produit', type: 'entity', path: '/products', placeholder: 'Sélectionner un produit', advanced: true, perm: 'product.read' },
  ];
  const filters = useListFilters(fields.map((x) => x.key)); const { page, params } = filters;
  const [state, setState] = useState({ loading: true }); const debounced = useDebouncedJson(params);
  const load = useCallback(async () => {
    try { const r = await api.get('/delivery-notes', { params: { ...JSON.parse(debounced), page, limit: PAGE_SIZE } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); }
  }, [debounced, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHeader title="Bons de livraison" subtitle="Quantités livrées, par commande ou par facture. Un bon se crée depuis une commande confirmée ou une facture émise ; il est numéroté à sa validation." />
      <Card>
        <ListFilters fields={fields} filters={filters} exportPath="/delivery-notes/export" exportName="bons-de-livraison.csv" onError={(t) => setState((st) => ({ ...st, exportError: t }))} />
        {state.exportError && <div className="px-4 pt-3"><Alert tone="error" onClose={() => setState((st) => ({ ...st, exportError: '' }))}>{state.exportError}</Alert></div>}
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={Truck} title="Aucun bon de livraison">Ouvrez une commande confirmée puis choisissez « Créer un bon de livraison ».</EmptyState>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Numéro</th><th className="px-4 py-3">Client</th><th className="px-4 py-3">Commande / facture</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Statut</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((n) => (
              <tr key={n.id} className="hover:bg-slate-50"><td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`/sales/delivery-notes/${n.id}`}>{n.number ?? 'Brouillon'}</Link></td>
                <td className="px-4 py-3 font-medium">{n.clientName}</td><td className="px-4 py-3 font-mono text-xs">{n.order ? <Link className="text-brand-700 hover:underline" to={`/sales/orders/${n.order.id}`}>{n.order.number}</Link> : n.sourceInvoice ? <Link className="text-brand-700 hover:underline" to={`/sales/invoices/${n.sourceInvoice.id}`}>Fact. {n.sourceInvoice.number}</Link> : '—'}</td>
                <td className="px-4 py-3">{fmtDate(n.deliveryDate)}</td><td className="px-4 py-3"><span className="inline-flex gap-1"><StatusBadge kind="delivery_note" doc={n} />{n.invoiced && <Badge tone="blue">Facturé</Badge>}</span></td></tr>
            ))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(p) => filters.set({ page: p })} />
      </Card>
    </>
  );
}

export function DeliveryViewPage() {
  const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth();
  const [doc, setDoc] = useState(null); const [error, setError] = useState(''); const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [busy, setBusy] = useState(''); const [modal, setModal] = useState(null); const [reason, setReason] = useState(''); const [hist, setHist] = useState(null);
  const load = useCallback(async () => { try { setDoc((await api.get(`/delivery-notes/${id}`)).data.data); setHist(null); } catch (e) { setError(errorMessage(e)); } }, [id]);
  useEffect(() => { load(); }, [load]);
  const run = async (key, fn, ok) => {
    setBusy(key); setNotice({ tone: 'success', text: '' });
    try { await fn(); if (ok) setNotice({ tone: 'success', text: ok }); await load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(''); }
  };
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!doc) return <Spinner />;
  const draft = doc.status === 'draft';
  return (
    <>
      <PageHeader title={doc.number ?? 'Bon de livraison (brouillon)'} subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge kind="delivery_note" doc={doc} /><span>{doc.client.name}</span></span>}
        actions={<div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => downloadCsv(`/delivery-notes/${id}/pdf`, undefined, `${doc.number ?? 'brouillon'}.pdf`).catch((e) => setNotice({ tone: 'error', text: errorMessage(e) }))}><Download size={16} aria-hidden /> PDF</Button>
          {doc.status === 'validated' && can('delivery.write') && <Button variant="secondary" onClick={() => setModal('mail')}><Mail size={16} aria-hidden /> Envoyer</Button>}
          {draft && can('delivery.validate') && <Button loading={busy === 'validate'} onClick={() => run('validate', () => api.post(`/delivery-notes/${id}/validate`), 'Bon validé : numéro attribué, contenu figé')}><CheckCircle2 size={16} aria-hidden /> Valider</Button>}
          {doc.status === 'validated' && doc.order && !doc.invoice && can('delivery.validate') && can('invoice.write') && <Button loading={busy === 'invoice'} onClick={() => run('invoice', async () => { const r = await api.post(`/delivery-notes/${id}/invoice`); navigate(`/sales/invoices/${r.data.data.invoiceId}`); })}><Receipt size={16} aria-hidden /> Facturer ces quantités</Button>}
          {doc.status === 'validated' && doc.order && can('sales_return.write') && <Button variant="secondary" onClick={() => setModal('return')}>Créer un bon de retour</Button>}
          {doc.status === 'validated' && can('delivery.validate') && <Button variant="secondary" onClick={() => setModal('cancel')}><Ban size={16} aria-hidden /> Annuler</Button>}
          {draft && can('delivery.delete') && <Button variant="ghost" onClick={() => setModal('delete')}><Trash2 size={16} className="text-red-600" aria-hidden /> Supprimer</Button>}
        </div>} />
      <div className="mb-4 space-y-3">
        <Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert>
        {doc.status === 'cancelled' && <Alert tone="error">Bon annulé — motif : {doc.cancelReason}. Les quantités redeviennent livrables sur la commande et les sorties de stock sont annulées.</Alert>}
        {doc.sourceInvoice && <Alert tone="info">Généré depuis la facture {doc.sourceInvoice.number}. {doc.stockImpact ? 'La validation fait sortir les articles suivis du stock.' : 'Document de livraison seul : la facture a déjà sorti le stock, aucun second mouvement.'}</Alert>}
        {doc.invoice && <Alert tone="info">Facturé : <Link className="font-medium underline" to={`/sales/invoices/${doc.invoice.id}`}>{doc.invoice.number ?? 'brouillon'}</Link>.</Alert>}
      </div>
      <Card className="min-w-0 p-5">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div><dt className="text-slate-500">Date de livraison</dt><dd>{fmtDate(doc.deliveryDate)}</dd></div>
          {doc.order ? <div><dt className="text-slate-500">Commande</dt><dd><Link className="text-brand-700 hover:underline" to={`/sales/orders/${doc.order.id}`}>{doc.order.number}</Link></dd></div> : <div><dt className="text-slate-500">Facture source</dt><dd>{doc.sourceInvoice ? <Link className="text-brand-700 hover:underline" to={`/sales/invoices/${doc.sourceInvoice.id}`}>{doc.sourceInvoice.number}</Link> : '—'}</dd></div>}
          <div><dt className="text-slate-500">Sortie de stock</dt><dd>{doc.warehouse?.name ?? '—'}</dd></div>
          <div><dt className="text-slate-500">Adresse</dt><dd>{doc.deliveryAddress ?? '—'}</dd></div>
          <div><dt className="text-slate-500">Véhicule</dt><dd>{doc.vehiclePlate ?? '—'}</dd></div>
        </dl>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[480px] text-left text-sm">
          <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2 text-right">Quantité livrée</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{doc.lines.map((l) => <tr key={l.id}><td className="px-3 py-2">{l.description}</td><td className="px-3 py-2 text-right tabular-nums">{Number(l.quantity)} {l.unit !== 'unité' ? l.unit : ''}</td></tr>)}</tbody></table></div>
        {doc.notes && <p className="mt-4 whitespace-pre-line text-sm text-slate-600">{doc.notes}</p>}
      </Card>
      <Card className="mt-4 p-5">
        <button className="flex w-full items-center gap-2 text-sm font-semibold" onClick={async () => setHist(hist ? null : (await api.get(`/delivery-notes/${id}/history`)).data.data)}><History size={16} aria-hidden /> Historique</button>
        {hist && <ul className="mt-3 space-y-2 text-sm">{hist.map((h, i) => <li key={i}><span className="font-medium">{h.action}</span> <span className="text-slate-500">· {h.by ?? 'système'} · {new Date(h.at).toLocaleString('fr-FR')}</span></li>)}</ul>}
      </Card>
      {modal === 'mail' && <EmailModal doc={doc} cfg={{ api: '/delivery-notes', one: 'bon de livraison' }} onClose={() => setModal(null)} onDone={(l) => { setModal(null); setNotice({ tone: 'success', text: `E-mail envoyé à ${l.join(', ')}` }); }} />}
      {modal === 'return' && <ReturnModal kind="sales" sourceId={doc.id} onClose={() => setModal(null)} onDone={(r) => navigate(`/sales/returns/${r.id}`)} />}
      {modal === 'cancel' && (
        <Modal title={`Annuler le bon ${doc.number}`} onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-slate-600">Le bon reste consultable, son numéro est conservé. Impossible s'il est facturé (annulez d'abord la facture).</p>
          <input aria-label="Motif d'annulation" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder="Motif (obligatoire)" className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Retour</Button><Button variant="danger" disabled={reason.trim().length < 5} onClick={async () => { setModal(null); await run('cancel', () => api.post(`/delivery-notes/${id}/cancel`, { reason }), 'Bon annulé'); }}>Annuler le bon</Button></div>
        </Modal>
      )}
      {modal === 'delete' && (
        <Modal title="Supprimer ce brouillon ?" onClose={() => setModal(null)}>
          <p className="text-sm text-slate-600">Le brouillon n'a pas de numéro : aucun trou de numérotation.</p>
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button variant="danger" onClick={async () => { try { await api.delete(`/delivery-notes/${id}`); navigate('/sales/delivery-notes'); } catch (e) { setModal(null); setNotice({ tone: 'error', text: errorMessage(e) }); } }}>Supprimer</Button></div>
        </Modal>
      )}
    </>
  );
}
