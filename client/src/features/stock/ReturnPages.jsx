import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, CheckCircle2, History, PackageX, Search, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { Pagination, useDebounced } from '../masterdata/shared.jsx';
import { fmtDate, todayIso } from '../sales/shared.jsx';
import ListFilters, { PAGE_SIZE, useDebouncedJson, useListFilters } from '../../components/ListFilters.jsx';

export const RCFG = {
  sales: { api: '/sales-returns', base: '/sales/returns', perm: 'sales_return', title: 'Bons de retour', one: 'bon de retour', srcBase: '/sales/delivery-notes', srcLabel: 'Bon de livraison', party: 'Client',
    subtitle: 'Marchandise rendue par un client : créez le retour depuis un bon de livraison validé ; à la validation, les articles suivis reviennent en stock.', effect: 'remis en stock', cancelNote: 'Le stock remis est de nouveau retiré (mouvement inverse).' },
  purchase: { api: '/purchase-returns', base: '/purchases/returns', perm: 'purchase_return', title: 'Retours fournisseur', one: 'retour fournisseur', srcBase: '/purchases/receipts', srcLabel: 'Réception', party: 'Fournisseur',
    subtitle: 'Marchandise renvoyée à un fournisseur : créez le retour depuis une réception validée ; à la validation, les articles suivis sortent du stock.', effect: 'sortis du stock', cancelNote: 'Le stock sorti est remis (mouvement inverse).' },
};
const ST = { draft: ['Brouillon', 'neutral'], validated: ['Validé', 'green'], cancelled: ['Annulé', 'red'] };
const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const ACTIONS = { 'create': 'Création', 'update': 'Modification', 'validate': 'Validé (stock mis à jour)', 'cancel': 'Annulé (stock inversé)', 'delete': 'Supprimé' };

export function ReturnList({ kind }) {
  const cfg = RCFG[kind];
  const fields = [
    { key: 'from', label: 'Date de début', type: 'date' }, { key: 'to', label: 'Date de fin', type: 'date' },
    { key: 'status', label: 'Statut', type: 'select', options: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['validated', 'Validés'], ['cancelled', 'Annulés']] },
    { key: 'q', label: 'Recherche avancée', type: 'search', advanced: true, placeholder: `Numéro, ${cfg.party.toLowerCase()}, document d'origine, motif…` },
  ];
  const filters = useListFilters(fields.map((x) => x.key)); const { page, params } = filters;
  const [state, setState] = useState({ loading: true }); const debounced = useDebouncedJson(params);
  const load = useCallback(async () => { try { const r = await api.get(cfg.api, { params: { ...JSON.parse(debounced), page, limit: PAGE_SIZE } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); } }, [cfg.api, debounced, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle} />
      <Card>
        <ListFilters fields={fields} filters={filters} exportPath={`${cfg.api}/export`} exportName={`${cfg.api.slice(1)}.csv`} onError={(t) => setState((st) => ({ ...st, exportError: t }))} />
        {state.exportError && <div className="px-4 pt-3"><Alert tone="error" onClose={() => setState((st) => ({ ...st, exportError: '' }))}>{state.exportError}</Alert></div>}
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={PackageX} title={filters.active ? 'Aucun résultat' : `Aucun ${cfg.one} pour l'instant`}>Ouvrez {kind === 'sales' ? 'un bon de livraison validé' : 'une réception validée'} puis choisissez « {kind === 'sales' ? 'Créer un bon de retour' : 'Créer un retour fournisseur'} ».</EmptyState>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Numéro</th><th className="px-4 py-3">{cfg.party}</th><th className="px-4 py-3">{cfg.srcLabel}</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Motif</th><th className="px-4 py-3">Statut</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((d) => (
              <tr key={d.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`${cfg.base}/${d.id}`}>{d.number ?? 'Brouillon'}</Link></td>
                <td className="px-4 py-3 font-medium text-slate-900">{d.partyName}</td>
                <td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`${cfg.srcBase}/${d.source.id}`}>{d.source.number}</Link></td>
                <td className="px-4 py-3">{fmtDate(d.returnDate)}</td><td className="px-4 py-3">{d.reason}</td>
                <td className="px-4 py-3"><Badge tone={ST[d.status][1]}>{ST[d.status][0]}</Badge></td>
              </tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(p) => filters.set({ page: p })} />
      </Card>
    </>
  );
}

// Création depuis un document d'origine validé : quantités par ligne, plafonnées au reste retournable (contrôle final côté serveur).
export function ReturnModal({ kind, sourceId, onClose, onDone }) {
  const cfg = RCFG[kind]; const [src, setSrc] = useState(null); const [qty, setQty] = useState({}); const [date, setDate] = useState(todayIso()); const [reason, setReason] = useState(''); const [notes, setNotes] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`${cfg.api}/source/${sourceId}`).then((r) => { setSrc(r.data.data); setQty(Object.fromEntries(r.data.data.lines.map((l) => [l.id, '0']))); }).catch((e) => setError(errorMessage(e))); }, [cfg.api, sourceId]);
  const submit = async () => {
    const lines = src.lines.filter((l) => Number(qty[l.id]) > 0).map((l) => ({ sourceLineId: l.id, quantity: qty[l.id] }));
    if (!lines.length) { setError('Indiquez au moins une quantité à retourner.'); return; }
    setBusy(true); setError('');
    try { onDone((await api.post(cfg.api, { sourceId, returnDate: date, reason, notes: notes || null, lines })).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={`${kind === 'sales' ? 'Bon de retour' : 'Retour fournisseur'}${src?.number ? ` — ${src.number}` : ''}`} onClose={onClose} size="lg"><div className="space-y-4">
      <Alert tone="error">{error}</Alert>
      {!src && !error ? <Spinner /> : src && <>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor="rt-date" className="mb-1 block text-sm font-medium">Date du retour</label><input id="rt-date" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} className={field} /></div>
          <div><label htmlFor="rt-reason" className="mb-1 block text-sm font-medium">Motif *</label><input id="rt-reason" value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} className={field} placeholder="Ex. produit défectueux, erreur de commande…" /></div>
        </div>
        <table className="w-full text-sm"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2">Désignation</th><th className="py-2 text-right">{kind === 'sales' ? 'Livré' : 'Reçu'}</th><th className="py-2 text-right">Déjà retourné</th><th className="py-2 text-right">À retourner</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{src.lines.map((l) => (
            <tr key={l.id}><td className="py-2">{l.description}</td><td className="py-2 text-right tabular-nums">{Number(l.quantity)}</td><td className="py-2 text-right tabular-nums">{Number(l.returnedQuantity)}</td>
              <td className="py-2 text-right"><input aria-label={`Quantité retournée ligne ${l.position}`} disabled={Number(l.returnableQuantity) <= 0} value={qty[l.id] ?? '0'} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} inputMode="decimal" className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right tabular-nums" /></td></tr>))}</tbody></table>
        <div><label htmlFor="rt-notes" className="mb-1 block text-sm font-medium">Notes</label><textarea id="rt-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={field} /></div>
        <p className="text-xs text-slate-500">Brouillon : à la validation, les articles suivis en stock sont {cfg.effect}. Aucun montant n'est généré : pour la correction financière, créez {kind === 'sales' ? 'un avoir sur la facture' : 'ou saisissez l\'avoir fournisseur reçu'}.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={reason.trim().length < 3} onClick={submit}>Créer le retour (brouillon)</Button></div>
      </>}
    </div></Modal>
  );
}

export function ReturnView({ kind }) {
  const cfg = RCFG[kind]; const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth();
  const [doc, setDoc] = useState(null); const [error, setError] = useState(''); const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [busy, setBusy] = useState(''); const [modal, setModal] = useState(null); const [reason, setReason] = useState(''); const [hist, setHist] = useState(null);
  const load = useCallback(async () => { try { setDoc((await api.get(`${cfg.api}/${id}`)).data.data); setHist(null); } catch (e) { setError(errorMessage(e)); } }, [cfg.api, id]);
  useEffect(() => { load(); }, [load]);
  const run = async (key, fn, ok) => { setBusy(key); setNotice({ tone: 'success', text: '' }); try { await fn(); if (ok) setNotice({ tone: 'success', text: ok }); await load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(''); } };
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!doc) return <Spinner />;
  const draft = doc.status === 'draft'; const P = cfg.perm;
  return (
    <>
      <PageHeader title={doc.number ?? `${cfg.one[0].toUpperCase()}${cfg.one.slice(1)} (brouillon)`} subtitle={<span className="inline-flex flex-wrap items-center gap-2"><Badge tone={ST[doc.status][1]}>{ST[doc.status][0]}</Badge><span>{doc.partyName}</span></span>}
        actions={<div className="flex flex-wrap gap-2">
          {draft && can(`${P}.validate`) && <Button loading={busy === 'validate'} onClick={() => run('validate', () => api.post(`${cfg.api}/${id}/validate`), 'Retour validé : numéro attribué, stock mis à jour')}><CheckCircle2 size={16} aria-hidden /> Valider le retour</Button>}
          {doc.status === 'validated' && can(`${P}.validate`) && <Button variant="secondary" onClick={() => { setReason(''); setModal('cancel'); }}><Ban size={16} aria-hidden /> Annuler</Button>}
          {draft && can(`${P}.delete`) && <Button variant="ghost" onClick={() => setModal('delete')}><Trash2 size={16} className="text-red-600" aria-hidden /> Supprimer</Button>}
        </div>} />
      <div className="mb-4 space-y-3">
        <Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert>
        {doc.status === 'cancelled' && <Alert tone="error">Retour annulé — motif : {doc.cancelReason}. {cfg.cancelNote}</Alert>}
        {draft && <Alert tone="info">Brouillon : le stock n'est modifié qu'à la validation.</Alert>}
      </div>
      <Card className="min-w-0 p-5">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div><dt className="text-slate-500">Date du retour</dt><dd>{fmtDate(doc.returnDate)}</dd></div>
          <div><dt className="text-slate-500">{cfg.srcLabel}</dt><dd><Link className="text-brand-700 hover:underline" to={`${cfg.srcBase}/${doc.source.id}`}>{doc.source.number}</Link></dd></div>
          <div><dt className="text-slate-500">Entrepôt</dt><dd>{doc.warehouse?.name ?? '—'}</dd></div>
          <div className="sm:col-span-3"><dt className="text-slate-500">Motif</dt><dd>{doc.reason}</dd></div>
        </dl>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[420px] text-left text-sm">
          <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2 text-right">Quantité retournée</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{doc.lines.map((l) => <tr key={l.id}><td className="px-3 py-2">{l.description}</td><td className="px-3 py-2 text-right tabular-nums">{Number(l.quantity)} {l.unit !== 'unité' ? l.unit : ''}</td></tr>)}</tbody></table></div>
        {doc.notes && <p className="mt-4 whitespace-pre-line text-sm text-slate-600">{doc.notes}</p>}
      </Card>
      <Card className="mt-4 p-5">
        <button className="flex w-full items-center gap-2 text-sm font-semibold" onClick={async () => setHist(hist ? null : (await api.get(`${cfg.api}/${id}/history`)).data.data)}><History size={16} aria-hidden /> Historique</button>
        {hist && <ul className="mt-3 space-y-2 text-sm" data-testid="history">{hist.map((h, i) => <li key={i}><span className="font-medium">{ACTIONS[h.action.split('.').pop()] ?? h.action}</span> <span className="text-slate-500">· {h.by ?? 'système'} · {new Date(h.at).toLocaleString('fr-FR')}</span></li>)}</ul>}
      </Card>
      {modal === 'cancel' && (
        <Modal title={`Annuler ${doc.number}`} onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-slate-600">Le retour reste consultable, son numéro est conservé. {cfg.cancelNote}</p>
          <input aria-label="Motif d'annulation" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder="Motif (obligatoire)" className={field} />
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Retour</Button><Button variant="danger" disabled={reason.trim().length < 5} onClick={async () => { await run('cancel', () => api.post(`${cfg.api}/${id}/cancel`, { reason }), 'Retour annulé'); setModal(null); }}>Confirmer l'annulation</Button></div>
        </Modal>)}
      {modal === 'delete' && (
        <Modal title="Supprimer ce brouillon ?" onClose={() => setModal(null)}>
          <p className="text-sm text-slate-600">Le brouillon n'a pas de numéro : aucun trou de numérotation.</p>
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button variant="danger" onClick={async () => { try { await api.delete(`${cfg.api}/${id}`); navigate(cfg.base); } catch (e) { setModal(null); setNotice({ tone: 'error', text: errorMessage(e) }); } }}>Supprimer</Button></div>
        </Modal>)}
    </>
  );
}
