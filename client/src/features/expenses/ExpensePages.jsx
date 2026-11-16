import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, CheckCircle2, Plus, Receipt, Search, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { Pagination, useDebounced } from '../masterdata/shared.jsx';
import { Combobox, fmtDate, fmtMoney, searchClients, todayIso } from '../sales/shared.jsx';
import { searchSuppliers } from '../purchases/SupplierPaymentModal.jsx';
import ListFilters, { PAGE_SIZE, useDebouncedJson, useListFilters } from '../../components/ListFilters.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
export const ECFG = {
  sales: { api: '/sales-expense-notes', base: '/sales/expense-notes', title: 'Notes de débours — Ventes', party: 'Client', key: 'clientId', search: searchClients, hint: "Sommes avancées pour le compte d'un client (droits, timbres, frais de greffe…), reportées à l'identique : sans TVA ni marge." },
  purchase: { api: '/purchase-expense-notes', base: '/purchases/expense-notes', title: 'Notes de débours — Achats', party: 'Fournisseur', key: 'supplierId', search: searchSuppliers, hint: 'Sommes avancées par un tiers (ou un fournisseur) pour votre compte, enregistrées à l\'identique : sans TVA.' },
};
const ST = { draft: ['Brouillon', 'neutral'], validated: ['Validée', 'green'], cancelled: ['Annulée', 'red'] };
const ACTIONS = { create: 'Création', update: 'Modification', validate: 'Validation', cancel: 'Annulation', delete: 'Suppression' };
const toMil = (s) => { const v = String(s ?? '').trim().replace(',', '.'); if (!/^\d+(\.\d{1,3})?$/.test(v)) return 0n; const [i, f = ''] = v.split('.'); return BigInt(i) * 1000n + BigInt(f.padEnd(3, '0')); };
const fromMil = (n) => `${n / 1000n}.${String(n % 1000n).padStart(3, '0')}`;

export function ExpenseList({ kind }) {
  const cfg = ECFG[kind]; const { can } = useAuth();
  const fields = [
    { key: 'projectId', label: 'Projet', type: 'entity', path: '/projects', placeholder: 'Sélectionner un projet', perm: 'project.read' },
    { key: 'from', label: 'Date de début', type: 'date' }, { key: 'to', label: 'Date de fin', type: 'date' },
    { key: 'status', label: 'Statut', type: 'select', options: [['', 'Tous les statuts'], ...Object.entries(ST).map(([k, v]) => [k, v[0]])] },
    { key: 'q', label: 'Recherche avancée', type: 'search', advanced: true, placeholder: `Numéro, ${cfg.party.toLowerCase()}, notes…` },
    { key: 'minAmount', label: 'Montant minimum', type: 'money', advanced: true }, { key: 'maxAmount', label: 'Montant maximum', type: 'money', advanced: true },
  ];
  const filters = useListFilters(fields.map((x) => x.key)); const { page, params } = filters;
  const [state, setState] = useState({ loading: true }); const debounced = useDebouncedJson(params);
  const load = useCallback(async () => { try { const r = await api.get(cfg.api, { params: { ...JSON.parse(debounced), page, limit: PAGE_SIZE } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); } }, [cfg.api, debounced, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHeader title={cfg.title} subtitle={cfg.hint} actions={can('expense_note.write') && <Link to={`${cfg.base}/new`}><Button><Plus size={16} aria-hidden /> Nouvelle note de débours</Button></Link>} />
      <Card>
        <ListFilters fields={fields} filters={filters} exportPath={`${cfg.api}/export`} exportName={`${cfg.api.slice(1)}.csv`} onError={(t) => setState((st) => ({ ...st, exportError: t }))} />
        {state.exportError && <div className="px-4 pt-3"><Alert tone="error" onClose={() => setState((st) => ({ ...st, exportError: '' }))}>{state.exportError}</Alert></div>}
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={Receipt} title="Aucune note de débours">Créez une note pour suivre les frais avancés pour le compte d'un tiers.</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Numéro</th><th className="px-4 py-3">{cfg.party}</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Projet</th><th className="px-4 py-3 text-right">Total</th><th className="px-4 py-3">Statut</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((n) => (
              <tr key={n.id} className="hover:bg-slate-50"><td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`${cfg.base}/${n.id}`}>{n.number ?? 'Brouillon'}</Link></td><td className="px-4 py-3 font-medium">{n.partyName}</td><td className="px-4 py-3">{fmtDate(n.date)}</td>
                <td className="px-4 py-3 text-xs">{n.project?.code ?? ''}</td><td className="px-4 py-3 text-right tabular-nums">{fmtMoney(n.total, n.currency)}</td><td className="px-4 py-3"><Badge tone={ST[n.status][1]}>{ST[n.status][0]}</Badge></td></tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(p) => filters.set({ page: p })} />
      </Card>
    </>
  );
}

export function ExpenseEditor({ kind }) {
  const cfg = ECFG[kind]; const { id } = useParams(); const navigate = useNavigate(); const isEdit = !!id;
  const [party, setParty] = useState(null); const [date, setDate] = useState(todayIso()); const [projectId, setProjectId] = useState(''); const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([{ description: '', payee: '', proofRef: '', amount: '' }]); const [projects, setProjects] = useState([]); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const [loading, setLoading] = useState(isEdit);
  useEffect(() => { api.get('/projects', { params: { status: 'active', limit: 100 } }).then((r) => setProjects(r.data.data)).catch(() => {}); }, []);
  useEffect(() => {
    if (!isEdit) return;
    api.get(`${cfg.api}/${id}`).then((r) => { const d = r.data.data; if (d.status !== 'draft') { navigate(`${cfg.base}/${id}`, { replace: true }); return; } setParty({ id: d.partyId, name: d.partyName }); setDate(d.date); setProjectId(d.project?.id ?? ''); setNotes(d.notes ?? ''); setLines(d.lines.map((l) => ({ description: l.description, payee: l.payee ?? '', proofRef: l.proofRef ?? '', amount: l.amount }))); setLoading(false); }).catch((e) => { setError(errorMessage(e)); setLoading(false); });
  }, [isEdit, id, cfg.api, cfg.base, navigate]);
  const total = lines.reduce((s, l) => s + toMil(l.amount), 0n); const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const save = async () => {
    setError(''); setSaving(true);
    const body = { [cfg.key]: party.id, noteDate: date, projectId: projectId || null, notes: notes || null, lines: lines.filter((l) => l.description || l.amount).map((l) => ({ description: l.description, payee: l.payee || null, proofRef: l.proofRef || null, amount: l.amount })) };
    try { const r = isEdit ? await api.put(`${cfg.api}/${id}`, body) : await api.post(cfg.api, body); navigate(`${cfg.base}/${r.data.data.id}`); } catch (e) { setError(errorMessage(e)); setSaving(false); }
  };
  if (loading) return <Spinner />;
  return (
    <>
      <PageHeader title={isEdit ? 'Modifier la note de débours' : 'Nouvelle note de débours'} subtitle={cfg.hint} actions={<div className="flex gap-2"><Button variant="secondary" onClick={() => navigate(cfg.base)}>Annuler</Button><Button loading={saving} disabled={!party || total <= 0n} onClick={save}>Enregistrer le brouillon</Button></div>} />
      <div className="mb-4"><Alert tone="error">{error}</Alert></div>
      <Card className="p-5"><div className="grid gap-4 sm:grid-cols-3">
        <Combobox id="en-party" label={`${cfg.party} *`} placeholder={`Rechercher un ${cfg.party.toLowerCase()}…`} fetcher={cfg.search} value={party?.name} render={(c) => ({ label: c.name, node: <span>{c.name} <span className="text-xs text-slate-400">{c.code}</span></span> })} onPick={(c) => setParty(c)} />
        <div><label htmlFor="en-date" className="mb-1 block text-sm font-medium text-slate-700">Date *</label><input id="en-date" type="date" className={field} max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label htmlFor="en-project" className="mb-1 block text-sm font-medium text-slate-700">Projet</label><select id="en-project" className={field} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">— Aucun —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></div>
      </div></Card>
      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Frais avancés</h2><Button type="button" variant="secondary" onClick={() => setLines([...lines, { description: '', payee: '', proofRef: '', amount: '' }])}><Plus size={16} aria-hidden /> Ajouter une ligne</Button></div>
        <div className="space-y-3">{lines.map((l, i) => (
          <div key={i} className="grid gap-3 rounded-md border border-slate-200 p-3 md:grid-cols-12">
            <div className="md:col-span-4"><label className="mb-1 block text-xs font-medium text-slate-600" htmlFor={`en-d-${i}`}>Désignation *</label><input id={`en-d-${i}`} className={field} value={l.description} maxLength={255} onChange={(e) => setLine(i, 'description', e.target.value)} /></div>
            <div className="md:col-span-3"><label className="mb-1 block text-xs font-medium text-slate-600" htmlFor={`en-p-${i}`}>Tiers payé</label><input id={`en-p-${i}`} className={field} value={l.payee} maxLength={160} onChange={(e) => setLine(i, 'payee', e.target.value)} /></div>
            <div className="md:col-span-2"><label className="mb-1 block text-xs font-medium text-slate-600" htmlFor={`en-r-${i}`}>N° justificatif</label><input id={`en-r-${i}`} className={field} value={l.proofRef} maxLength={80} onChange={(e) => setLine(i, 'proofRef', e.target.value)} /></div>
            <div className="md:col-span-2"><label className="mb-1 block text-xs font-medium text-slate-600" htmlFor={`en-a-${i}`}>Montant *</label><input id={`en-a-${i}`} inputMode="decimal" className={`${field} text-right`} value={l.amount} onChange={(e) => setLine(i, 'amount', e.target.value)} /></div>
            <div className="flex items-end md:col-span-1">{lines.length > 1 && <Button type="button" variant="ghost" aria-label={`Supprimer la ligne ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 size={16} className="text-red-600" /></Button>}</div>
          </div>))}</div>
        <div className="mt-4 flex justify-end text-base font-semibold">Total : <span className="ml-2 tabular-nums" data-testid="en-total">{fmtMoney(fromMil(total))}</span></div>
        <div className="mt-3"><label htmlFor="en-notes" className="mb-1 block text-sm font-medium text-slate-700">Note</label><textarea id="en-notes" rows={2} className={field} value={notes} maxLength={3000} onChange={(e) => setNotes(e.target.value)} /></div>
      </Card>
    </>
  );
}

export function ExpenseView({ kind }) {
  const cfg = ECFG[kind]; const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth();
  const [doc, setDoc] = useState(null); const [error, setError] = useState(''); const [notice, setNotice] = useState({ tone: 'success', text: '' }); const [modal, setModal] = useState(null); const [reason, setReason] = useState(''); const [hist, setHist] = useState(null); const [busy, setBusy] = useState('');
  const load = useCallback(async () => { try { setDoc((await api.get(`${cfg.api}/${id}`)).data.data); setHist(null); } catch (e) { setError(errorMessage(e)); } }, [cfg.api, id]);
  useEffect(() => { load(); }, [load]);
  const run = async (key, fn, ok) => { setBusy(key); try { await fn(); setNotice({ tone: 'success', text: ok }); await load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } setBusy(''); setModal(null); };
  if (error) return <Alert tone="error">{error}</Alert>; if (!doc) return <Spinner />;
  const draft = doc.status === 'draft';
  return (
    <>
      <PageHeader title={doc.number ?? 'Note de débours (brouillon)'} subtitle={<span className="inline-flex items-center gap-2"><Badge tone={ST[doc.status][1]}>{ST[doc.status][0]}</Badge> {doc.partyName}</span>}
        actions={<div className="flex flex-wrap gap-2">
          {draft && can('expense_note.write') && <Link to={`${cfg.base}/${id}/edit`}><Button variant="secondary">Modifier</Button></Link>}
          {draft && can('expense_note.validate') && <Button loading={busy === 'v'} onClick={() => run('v', () => api.post(`${cfg.api}/${id}/validate`), 'Note validée : numéro attribué')}><CheckCircle2 size={16} aria-hidden /> Valider</Button>}
          {doc.status === 'validated' && can('expense_note.validate') && <Button variant="secondary" onClick={() => { setReason(''); setModal('cancel'); }}><Ban size={16} aria-hidden /> Annuler</Button>}
          {draft && can('expense_note.delete') && <Button variant="ghost" onClick={() => setModal('delete')}><Trash2 size={16} className="text-red-600" aria-hidden /> Supprimer</Button>}</div>} />
      <div className="mb-4 space-y-3"><Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert>
        {doc.status === 'cancelled' && <Alert tone="error">Note annulée — motif : {doc.cancelReason}</Alert>}{draft && <Alert tone="info">Brouillon : le numéro définitif est attribué à la validation. Une note validée n'est plus modifiable.</Alert>}</div>
      <Card className="p-5">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3"><div><dt className="text-slate-500">Date</dt><dd>{fmtDate(doc.date)}</dd></div><div><dt className="text-slate-500">{cfg.party}</dt><dd>{doc.partyName}</dd></div><div><dt className="text-slate-500">Projet</dt><dd>{doc.project ? <Link className="text-brand-700 hover:underline" to={`/projects/${doc.project.id}`}>{doc.project.code} — {doc.project.name}</Link> : '—'}</dd></div></dl>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2">Tiers payé</th><th className="px-3 py-2">Justificatif</th><th className="px-3 py-2 text-right">Montant</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{doc.lines.map((l, i) => <tr key={i}><td className="px-3 py-2">{l.description}</td><td className="px-3 py-2">{l.payee}</td><td className="px-3 py-2">{l.proofRef}</td><td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.amount, doc.currency)}</td></tr>)}</tbody>
          <tfoot><tr className="border-t border-slate-200 font-semibold"><td className="px-3 py-2" colSpan={3}>Total (sans TVA)</td><td className="px-3 py-2 text-right tabular-nums">{fmtMoney(doc.total, doc.currency)}</td></tr></tfoot></table></div>
        {doc.notes && <p className="mt-4 whitespace-pre-line text-sm text-slate-600">{doc.notes}</p>}
      </Card>
      <Card className="mt-4 p-5"><button className="text-sm font-semibold" onClick={async () => setHist(hist ? null : (await api.get(`${cfg.api}/${id}/history`)).data.data)}>Historique</button>
        {hist && <ul className="mt-3 space-y-1 text-sm">{hist.map((h, i) => <li key={i}>{ACTIONS[h.action.split('.').pop()] ?? h.action} <span className="text-slate-500">· {h.by} · {new Date(h.at).toLocaleString('fr-FR')}</span></li>)}</ul>}</Card>
      {modal === 'cancel' && <Modal title={`Annuler ${doc.number}`} onClose={() => setModal(null)}><p className="mb-3 text-sm text-slate-600">La note est conservée avec son motif.</p><input aria-label="Motif d'annulation" className={field} value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} placeholder="Motif (obligatoire)" />
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Retour</Button><Button variant="danger" disabled={reason.trim().length < 5} onClick={() => run('c', () => api.post(`${cfg.api}/${id}/cancel`, { reason }), 'Note annulée')}>Annuler la note</Button></div></Modal>}
      {modal === 'delete' && <Modal title="Supprimer ce brouillon ?" onClose={() => setModal(null)}><p className="text-sm text-slate-600">Le brouillon sera supprimé définitivement (aucun numéro n'a été attribué).</p><div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Retour</Button><Button variant="danger" onClick={async () => { try { await api.delete(`${cfg.api}/${id}`); navigate(cfg.base); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); setModal(null); } }}>Supprimer</Button></div></Modal>}
    </>
  );
}
