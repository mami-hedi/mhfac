import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search, Wallet } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { ExportButton, Pagination, useDebounced } from '../masterdata/shared.jsx';
import AllocateModal from '../treasury/AllocateModal.jsx';
import { fmtDate, fmtMoney } from '../sales/shared.jsx';
import SupplierPaymentModal, { METHOD_LABELS } from './SupplierPaymentModal.jsx';

export default function SupplierPaymentsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [f, setF] = useState({ q: '', status: '', method: '', page: 1 });
  const q = useDebounced(f.q);
  const [state, setState] = useState({ loading: true });
  const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [create, setCreate] = useState(() => !!params.get('new') && can('payment.write'));
  const [alloc, setAlloc] = useState(null);
  const [cancel, setCancel] = useState(null); const [reason, setReason] = useState('');
  useEffect(() => { if (params.get('new')) { params.delete('new'); setParams(params, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    try {
      const r = await api.get('/supplier-payments', { params: { q: q || undefined, status: f.status || undefined, method: f.method || undefined, page: f.page, limit: 15 } });
      setState({ rows: r.data.data, meta: r.data.meta });
    } catch (e) { setState({ error: errorMessage(e) }); }
  }, [q, f.status, f.method, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF({ ...f, ...patch, page: 1 });

  return (
    <>
      <PageHeader title="Règlements fournisseur" subtitle="Règlements versés à vos fournisseurs, affectés à leurs factures d'achat. Un règlement n'est jamais supprimé : il s'annule avec un motif."
        actions={<><ExportButton path="/supplier-payments/export" params={{ q: q || undefined, status: f.status || undefined, method: f.method || undefined }} filename="paiements-fournisseurs.csv" onError={(text) => setNotice({ tone: 'error', text })} />{can('payment.write') && <Button onClick={() => setCreate(true)}><Plus size={16} aria-hidden /> Nouveau règlement</Button>}</>} />
      <div className="mb-4"><Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert></div>
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <div className="relative min-w-[220px] flex-1"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" aria-hidden />
            <input aria-label="Rechercher" placeholder="N° de règlement, fournisseur, référence…" value={f.q} onChange={(e) => set({ q: e.target.value })} className="block w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm" /></div>
          <select aria-label="Mode" value={f.method} onChange={(e) => set({ method: e.target.value })} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Tous les modes</option>{Object.entries(METHOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select aria-label="Statut" value={f.status} onChange={(e) => set({ status: e.target.value })} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Tous</option><option value="recorded">Enregistrés</option><option value="cancelled">Annulés</option></select>
        </div>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={Wallet} title={f.q || f.status || f.method ? 'Aucun résultat' : "Aucun règlement pour l'instant"} action={!f.q && can('payment.write') && <Button onClick={() => setCreate(true)}><Plus size={16} aria-hidden /> Enregistrer un règlement</Button>}>
            Les règlements se créent ici ou depuis une facture d'achat enregistrée.</EmptyState>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">N°</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Fournisseur</th><th className="px-4 py-3">Mode</th><th className="px-4 py-3">Factures</th><th className="px-4 py-3 text-right">Montant</th><th className="px-4 py-3 text-right">Non affecté</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((p) => (
              <tr key={p.id} className={p.status === 'cancelled' ? 'text-slate-400 line-through' : ''}>
                <td className="px-4 py-3 font-mono text-xs">{p.number}</td><td className="px-4 py-3">{fmtDate(p.date)}</td><td className="px-4 py-3">{p.supplierName}</td>
                <td className="px-4 py-3">{p.methodLabel}{p.reference ? <span className="text-xs text-slate-500"> · {p.reference}</span> : ''}</td>
                <td className="px-4 py-3 text-xs">{p.allocations.length ? 'voir détail' : ''}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(p.amount, p.currency)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{p.status === 'recorded' && Number(p.unallocated) > 0 ? <>{fmtMoney(p.unallocated, p.currency)}{can('payment.write') && <button type="button" className="ml-2 text-xs text-brand-700 hover:underline" aria-label={`Affecter ${p.number}`} onClick={() => setAlloc(p)}>Affecter</button>}</> : ''}</td>
                <td className="px-4 py-3"><Badge tone={p.status === 'recorded' ? 'green' : 'red'}>{p.status === 'recorded' ? 'Enregistré' : 'Annulé'}</Badge></td>
                <td className="px-4 py-3 text-right">{p.status === 'recorded' && can('payment.validate') && <Button variant="ghost" aria-label={`Annuler le règlement ${p.number}`} onClick={() => { setCancel(p); setReason(''); }}>Annuler</Button>}</td>
              </tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(page) => setF({ ...f, page })} />
      </Card>
      {create && <SupplierPaymentModal onClose={() => setCreate(false)} onDone={(p) => { setCreate(false); setNotice({ tone: 'success', text: `Règlement ${p.number} enregistré` }); load(); }} />}
      {alloc && <AllocateModal payment={alloc} kind="supplier" onClose={() => setAlloc(null)} onDone={() => { setAlloc(null); setNotice({ tone: 'success', text: 'Avance affectée' }); load(); }} />}
      {cancel && (
        <Modal title={`Annuler le règlement ${cancel.number}`} onClose={() => setCancel(null)}>
          <p className="mb-3 text-sm text-slate-600">Le règlement est conservé avec son motif ; le solde des factures concernées est rétabli.</p>
          <input aria-label="Motif d'annulation" value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} placeholder="Motif (obligatoire)" className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setCancel(null)}>Retour</Button>
            <Button variant="danger" disabled={reason.trim().length < 5} onClick={async () => { try { await api.post(`/supplier-payments/${cancel.id}/cancel`, { reason }); setNotice({ tone: 'success', text: `${cancel.number} annulé` }); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } setCancel(null); load(); }}>Annuler le règlement</Button></div>
        </Modal>
      )}
    </>
  );
}
