import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileCheck2, Search } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { Pagination, useDebounced } from '../masterdata/shared.jsx';
import { fmtDate, fmtMoney, todayIso } from '../sales/shared.jsx';
import TejPrepCard from './TejPrepCard.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const CFG = {
  sales: { api: '/withholdings/sales', title: 'Retenue à la source — Ventes', party: 'Client', docBase: '/sales/invoices', pending: 'Attestation à recevoir', done: 'Attestation reçue', action: "Saisir l'attestation reçue",
    subtitle: "Retenues opérées par vos clients sur vos factures émises. Suivez la réception de l'attestation de retenue ; le montant vient de la facture (ou de la retenue enregistrée après émission) et n'est jamais modifiable ici." },
  purchases: { api: '/withholdings/purchases', title: 'Retenue à la source — Achats / Autres', party: 'Fournisseur', docBase: '/purchases/invoices', pending: 'Attestation à délivrer', done: 'Attestation délivrée', action: "Saisir l'attestation délivrée",
    subtitle: "Retenues que vous opérez sur les factures d'achat enregistrées. Suivez la remise de l'attestation au fournisseur ; le reversement à l'administration reste à faire hors de l'application." },
};

export default function WithholdingPage({ kind }) {
  const cfg = CFG[kind]; const { can } = useAuth();
  const [f, setF] = useState({ q: '', status: '', from: '', to: '', page: 1 }); const q = useDebounced(f.q); const [state, setState] = useState({ loading: true });
  const [edit, setEdit] = useState(null); const [form, setForm] = useState({ status: 'done', certificateNumber: '', certificateDate: todayIso(), notes: '' }); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const load = useCallback(async () => { try { const r = await api.get(cfg.api, { params: { q: q || undefined, status: f.status || undefined, from: f.from || undefined, to: f.to || undefined, page: f.page, limit: 15 } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); } }, [cfg.api, q, f.status, f.from, f.to, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF({ ...f, ...patch, page: 1 });
  const open = (r) => { setEdit(r); setError(''); setForm({ status: 'done', certificateNumber: r.certificate.number ?? '', certificateDate: r.certificate.date ?? todayIso(), notes: r.certificate.notes ?? '' }); };
  const save = async (status) => {
    setError('');
    try { await api.put(`${cfg.api}/${edit.invoiceId}/certificate`, { ...form, status }); setNotice(status === 'done' ? 'Attestation enregistrée' : 'Attestation remise « en attente »'); setEdit(null); load(); } catch (e) { setError(errorMessage(e)); }
  };
  const m = state.meta; const sel = 'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
  return (
    <>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle} />
      {kind === 'purchases' && can('withholding.read') && <TejPrepCard />}
      <div className="mb-4"><Alert tone="success" onClose={() => setNotice('')}>{notice}</Alert></div>
      {m && <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card><div className="p-4"><p className="text-xs uppercase text-slate-500">Total des retenues (filtre)</p><p className="text-xl font-semibold tabular-nums">{fmtMoney(m.totalTnd)}</p></div></Card>
        <Card><div className="p-4"><p className="text-xs uppercase text-slate-500">{cfg.done}</p><p className="text-xl font-semibold tabular-nums text-green-700">{fmtMoney(m.certifiedTnd)}</p></div></Card>
        <Card><div className="p-4"><p className="text-xs uppercase text-slate-500">{cfg.pending}</p><p className="text-xl font-semibold tabular-nums text-orange-600">{fmtMoney((Number(m.totalTnd) - Number(m.certifiedTnd)).toFixed(3))}</p></div></Card></div>}
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <div className="relative min-w-[220px] flex-1"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" aria-hidden /><input aria-label="Rechercher" placeholder={`Facture, ${cfg.party.toLowerCase()}, n° d'attestation…`} value={f.q} onChange={(e) => set({ q: e.target.value })} className="block w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm" /></div>
          <select aria-label="Statut" className={sel} value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="">Toutes</option><option value="pending">{cfg.pending}</option><option value="done">{cfg.done}</option></select>
          <input aria-label="Du" type="date" className={sel} value={f.from} onChange={(e) => set({ from: e.target.value })} /><input aria-label="Au" type="date" className={sel} value={f.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={FileCheck2} title="Aucune retenue à la source">Les factures {kind === 'sales' ? 'émises' : "d'achat enregistrées"} avec un taux de retenue apparaissent ici.</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Facture</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">{cfg.party}</th><th className="px-4 py-3 text-right">TTC</th><th className="px-4 py-3 text-right">Taux</th><th className="px-4 py-3 text-right">Retenue</th><th className="px-4 py-3">Attestation</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((r) => (
              <tr key={r.invoiceId}><td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`${cfg.docBase}/${r.invoiceId}`}>{r.number}</Link>{r.added && <div className="text-amber-700">Ajoutée après émission</div>}{r.supplierRef && <div className="text-slate-500">Réf. {r.supplierRef}</div>}</td>
                <td className="px-4 py-3">{fmtDate(r.date)}</td><td className="px-4 py-3">{r.party.name}{r.party.taxId && <div className="text-xs text-slate-500">MF {r.party.taxId}</div>}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(r.totalTtc, r.currency)}</td><td className="px-4 py-3 text-right tabular-nums">{Number(r.rate)} %</td><td className="px-4 py-3 text-right tabular-nums font-medium">{fmtMoney(r.amount, r.currency)}</td>
                <td className="px-4 py-3">{r.certificate.status === 'done' ? <><Badge tone="green">{cfg.done}</Badge><div className="text-xs text-slate-500">N° {r.certificate.number} · {fmtDate(r.certificate.date)}</div></> : <Badge tone="orange">{cfg.pending}</Badge>}</td>
                <td className="px-4 py-3 text-right">{can('withholding.write') && <Button variant="ghost" onClick={() => open(r)}>{r.certificate.status === 'done' ? 'Modifier' : 'Saisir'}</Button>}</td></tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(page) => setF({ ...f, page })} />
      </Card>
      {edit && (
        <Modal title={`Attestation — facture ${edit.number}`} onClose={() => setEdit(null)}>
          <div className="space-y-3"><Alert tone="error">{error}</Alert>
            <p className="text-sm text-slate-600">Retenue : <strong>{fmtMoney(edit.amount, edit.currency)}</strong> ({cfg.party.toLowerCase()} : {edit.party.name})</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label htmlFor="wc-num" className="mb-1 block text-sm font-medium text-slate-700">N° de l'attestation *</label><input id="wc-num" className={field} maxLength={60} value={form.certificateNumber} onChange={(e) => setForm({ ...form, certificateNumber: e.target.value })} /></div>
              <div><label htmlFor="wc-date" className="mb-1 block text-sm font-medium text-slate-700">Date *</label><input id="wc-date" type="date" className={field} value={form.certificateDate} onChange={(e) => setForm({ ...form, certificateDate: e.target.value })} /></div></div>
            <div><label htmlFor="wc-notes" className="mb-1 block text-sm font-medium text-slate-700">Note</label><input id="wc-notes" className={field} maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            <div className="flex justify-between gap-2"><div>{edit.certificate.status === 'done' && <Button variant="ghost" onClick={() => save('pending')}>Remettre « en attente »</Button>}</div>
              <div className="flex gap-2"><Button variant="secondary" onClick={() => setEdit(null)}>Annuler</Button><Button disabled={!form.certificateNumber || !form.certificateDate} onClick={() => save('done')}>Enregistrer</Button></div></div></div>
        </Modal>
      )}
    </>
  );
}
