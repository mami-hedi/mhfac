import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FolderOpen, Link2, Plus, Search, Unlink } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { Pagination, useDebounced } from '../masterdata/shared.jsx';
import { Combobox, fmtDate, fmtMoney, searchClients } from '../sales/shared.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const ST = { active: ['En cours', 'blue'], on_hold: ['En pause', 'orange'], completed: ['Terminé', 'green'], cancelled: ['Annulé', 'red'] };
const Lbl = ({ id, children }) => <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">{children}</label>;

export function ProjectModal({ project, onClose, onDone }) {
  const [f, setF] = useState({ name: project?.name ?? '', code: project?.code ?? '', status: project?.status ?? 'active', startDate: project?.startDate ?? '', endDate: project?.endDate ?? '', budget: project?.budget ?? '', description: project?.description ?? '' });
  const [client, setClient] = useState(project?.client ?? null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true); setError('');
    const body = { name: f.name, code: f.code || null, clientId: client?.id ?? null, status: f.status, startDate: f.startDate || null, endDate: f.endDate || null, budget: f.budget || null, description: f.description || null };
    try { onDone((project ? await api.put(`/projects/${project.id}`, body) : await api.post('/projects', body)).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={project ? `Modifier ${project.code}` : 'Nouveau projet'} onClose={onClose} size="lg">
      <div className="space-y-3"><Alert tone="error">{error}</Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Lbl id="pj-name">Nom *</Lbl><input id="pj-name" className={field} value={f.name} maxLength={160} onChange={set('name')} /></div>
          <div><Lbl id="pj-code">Code {project ? '' : '(auto si vide)'}</Lbl><input id="pj-code" className={field} value={f.code} maxLength={40} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></div>
          <Combobox id="pj-client" label="Client" placeholder="Rechercher un client…" fetcher={searchClients} value={client?.name} render={(c) => ({ label: c.name, node: <span>{c.name} <span className="text-xs text-slate-400">{c.code}</span></span> })} onPick={(c) => setClient(c)} />
          <div><Lbl id="pj-status">Statut</Lbl><select id="pj-status" className={field} value={f.status} onChange={set('status')}>{Object.entries(ST).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div><Lbl id="pj-start">Début</Lbl><input id="pj-start" type="date" className={field} value={f.startDate} onChange={set('startDate')} /></div>
          <div><Lbl id="pj-end">Fin prévue</Lbl><input id="pj-end" type="date" className={field} value={f.endDate} onChange={set('endDate')} /></div>
          <div><Lbl id="pj-budget">Budget de dépenses</Lbl><input id="pj-budget" inputMode="decimal" className={field} value={f.budget} onChange={set('budget')} placeholder="optionnel" /></div></div>
        {client && <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setClient(null)}>Retirer le client</button>}
        <div><Lbl id="pj-desc">Description</Lbl><textarea id="pj-desc" rows={3} className={field} value={f.description} maxLength={5000} onChange={set('description')} /></div>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={f.name.trim().length < 2} onClick={submit}>Enregistrer</Button></div></div>
    </Modal>
  );
}

export function ProjectList() {
  const { can } = useAuth(); const navigate = useNavigate(); const [f, setF] = useState({ q: '', status: '', page: 1 }); const q = useDebounced(f.q); const [state, setState] = useState({ loading: true }); const [create, setCreate] = useState(false);
  const load = useCallback(async () => { try { const r = await api.get('/projects', { params: { q: q || undefined, status: f.status || undefined, page: f.page, limit: 15 } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); } }, [q, f.status, f.page]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHeader title="Projets" subtitle="Regroupez devis, commandes, factures, achats et débours d'une même affaire pour suivre budget et marge." actions={can('project.write') && <Button onClick={() => setCreate(true)}><Plus size={16} aria-hidden /> Nouveau projet</Button>} />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <div className="relative min-w-[220px] flex-1"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" aria-hidden /><input aria-label="Rechercher" placeholder="Code, nom, client…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} className="block w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm" /></div>
          <select aria-label="Statut" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Tous les statuts</option>{Object.entries(ST).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={FolderOpen} title="Aucun projet">Créez un projet puis rattachez-y vos documents.</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Code</th><th className="px-4 py-3">Projet</th><th className="px-4 py-3">Client</th><th className="px-4 py-3">Période</th><th className="px-4 py-3 text-right">Budget</th><th className="px-4 py-3">Statut</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50"><td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`/projects/${p.id}`}>{p.code}</Link></td><td className="px-4 py-3 font-medium">{p.name}</td><td className="px-4 py-3">{p.client?.name ?? '—'}</td>
                <td className="px-4 py-3 text-xs">{p.startDate ? fmtDate(p.startDate) : '—'}{p.endDate ? ` → ${fmtDate(p.endDate)}` : ''}</td><td className="px-4 py-3 text-right tabular-nums">{p.budget ? fmtMoney(p.budget) : '—'}</td><td className="px-4 py-3"><Badge tone={ST[p.status][1]}>{ST[p.status][0]}</Badge></td></tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(page) => setF({ ...f, page })} />
      </Card>
      {create && <ProjectModal onClose={() => setCreate(false)} onDone={(p) => navigate(`/projects/${p.id}`)} />}
    </>
  );
}

const LINK_TYPES = { quote: 'Devis', sales_order: 'Commande client', invoice: 'Facture', credit_note: 'Avoir', purchase_order: 'Commande fournisseur', purchase_invoice: "Facture d'achat", purchase_credit_note: 'Avoir fournisseur', expense_note_sales: 'Note de débours (vente)', expense_note_purchase: 'Note de débours (achat)' };
function LinkModal({ project, onClose, onDone }) {
  const [docType, setDocType] = useState('invoice'); const [q, setQ] = useState(''); const dq = useDebounced(q); const [rows, setRows] = useState(null); const [error, setError] = useState('');
  useEffect(() => { setRows(null); api.get(`/projects/${project.id}/linkable`, { params: { docType, q: dq || undefined } }).then((r) => setRows(r.data.data)).catch((e) => setError(errorMessage(e))); }, [project.id, docType, dq]);
  const link = async (d) => { try { await api.post(`/projects/${project.id}/documents`, { docType, docId: d.id }); onDone(); } catch (e) { setError(errorMessage(e)); } };
  return (
    <Modal title="Rattacher un document" onClose={onClose} size="lg">
      <div className="space-y-3"><Alert tone="error">{error}</Alert>
        <div className="grid gap-3 sm:grid-cols-2"><div><Lbl id="lk-type">Type</Lbl><select id="lk-type" className={field} value={docType} onChange={(e) => { setDocType(e.target.value); setError(''); }}>{Object.entries(LINK_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div><Lbl id="lk-q">Rechercher</Lbl><input id="lk-q" className={field} value={q} placeholder="Numéro ou tiers" onChange={(e) => setQ(e.target.value)} /></div></div>
        {!rows ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-slate-500">Aucun document disponible (non rattaché, non annulé).</p> : (
          <table className="w-full text-sm"><tbody className="divide-y divide-slate-100">{rows.map((d) => (
            <tr key={d.id}><td className="py-2 font-mono text-xs">{d.number}</td><td className="py-2">{d.partyName}</td><td className="py-2 text-xs">{fmtDate(d.date)}</td><td className="py-2 text-right tabular-nums">{fmtMoney(d.totalHt)}</td><td className="py-2 text-right"><Button variant="secondary" onClick={() => link(d)}><Link2 size={14} aria-hidden /> Rattacher</Button></td></tr>))}</tbody></table>)}
      </div>
    </Modal>
  );
}

export function ProjectView() {
  const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth(); const [p, setP] = useState(null); const [error, setError] = useState(''); const [modal, setModal] = useState(null); const [notice, setNotice] = useState('');
  const load = useCallback(async () => { try { setP((await api.get(`/projects/${id}`)).data.data); } catch (e) { setError(errorMessage(e)); } }, [id]);
  useEffect(() => { load(); }, [load]);
  const unlink = async (d) => { try { await api.delete(`/projects/${id}/documents/${d.docType}/${d.id}`); load(); } catch (e) { setNotice(errorMessage(e)); } };
  if (error) return <Alert tone="error">{error}</Alert>; if (!p) return <Spinner />;
  const s = p.summary; const tile = (label, v, tone = '') => <Card><div className="p-4"><p className="text-xs uppercase text-slate-500">{label}</p><p className={`text-xl font-semibold tabular-nums ${tone}`}>{fmtMoney(v)}</p></div></Card>;
  return (
    <>
      <PageHeader title={`${p.code} — ${p.name}`} subtitle={<span className="inline-flex flex-wrap items-center gap-2"><Badge tone={ST[p.status][1]}>{ST[p.status][0]}</Badge>{p.client && <span>{p.client.name}</span>}{p.startDate && <span className="text-xs">{fmtDate(p.startDate)}{p.endDate ? ` → ${fmtDate(p.endDate)}` : ''}</span>}</span>}
        actions={<div className="flex gap-2">{can('project.write') && <Button variant="secondary" onClick={() => setModal('edit')}>Modifier</Button>}{can('project.write') && !['completed', 'cancelled'].includes(p.status) && <Button onClick={() => setModal('link')}><Link2 size={16} aria-hidden /> Rattacher un document</Button>}</div>} />
      <div className="mb-4"><Alert tone="error" onClose={() => setNotice('')}>{notice}</Alert></div>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile('Facturé (HT, net des avoirs)', s.invoiced)}{tile('Achats (HT, net des avoirs)', s.purchased)}{tile('Marge (facturé − achats)', s.margin, s.margin.startsWith('-') ? 'text-red-600' : 'text-green-700')}{tile('Résultat (avec débours)', s.result, s.result.startsWith('-') ? 'text-red-600' : '')}
      </div>
      {s.budget && <Card className="mb-4"><div className="p-4 text-sm"><div className="mb-1 flex justify-between"><span>Budget de dépenses : <strong>{fmtMoney(s.budget)}</strong> · Dépensé : <strong>{fmtMoney(s.costs)}</strong></span><span className={s.budgetRemaining.startsWith('-') ? 'font-semibold text-red-600' : ''}>Reste : {fmtMoney(s.budgetRemaining)} ({s.budgetUsedPct} %)</span></div>
        <div className="h-2 overflow-hidden rounded bg-slate-100"><div className={`h-2 ${s.budgetUsedPct > 100 ? 'bg-red-500' : 'bg-brand-600'}`} style={{ width: `${Math.min(100, s.budgetUsedPct ?? 0)}%` }} /></div></div></Card>}
      <Card>
        <div className="border-b border-slate-200 p-4 text-sm font-medium">Documents rattachés ({p.documents.length})</div>
        {p.documents.length === 0 ? <EmptyState icon={FolderOpen} title="Aucun document rattaché">Rattachez des devis, factures, achats ou notes de débours.</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Type</th><th className="px-4 py-3">Numéro</th><th className="px-4 py-3">Tiers</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3 text-right">HT</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{p.documents.map((d) => (
              <tr key={`${d.docType}-${d.id}`}><td className="px-4 py-3">{d.label}</td><td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={d.path}>{d.number ?? 'Brouillon'}</Link></td><td className="px-4 py-3">{d.partyName}</td><td className="px-4 py-3">{fmtDate(d.date)}</td><td className="px-4 py-3 text-xs">{d.status}</td><td className="px-4 py-3 text-right tabular-nums">{fmtMoney(d.totalHt, d.currency)}</td>
                <td className="px-4 py-3 text-right">{can('project.write') && <Button variant="ghost" aria-label={`Détacher ${d.number}`} onClick={() => unlink(d)}><Unlink size={15} /></Button>}</td></tr>))}</tbody></table></div>)}
      </Card>
      <p className="mt-3 text-xs text-slate-500">{s.note} Seuls les documents émis, enregistrés ou validés comptent dans la synthèse.</p>
      {p.description && <Card className="mt-4 p-5"><p className="whitespace-pre-line text-sm text-slate-600">{p.description}</p></Card>}
      {modal === 'edit' && <ProjectModal project={p} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
      {modal === 'link' && <LinkModal project={p} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
    </>
  );
}
