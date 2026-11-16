import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Pause, Pencil, Play, Plus, Square, Trash2, Zap } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { Pagination } from '../masterdata/shared.jsx';
import { Combobox, fmtDate, fmtMoney, searchClients, todayIso } from './shared.jsx';

const FREQ = { weekly: 'Chaque semaine', monthly: 'Chaque mois', quarterly: 'Chaque trimestre', yearly: 'Chaque année' };
const STATUS = { active: ['Active', 'green'], paused: ['En pause', 'orange'], ended: ['Terminée', 'neutral'] };
const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const blankLine = (taxRateId = '') => ({ description: '', quantity: '1', unitPrice: '0', discountPct: '0', taxRateId });

function RecurringForm({ initial, taxRates, onClose, onDone }) {
  const rates = taxRates.filter((t) => t.isActive); const def = rates.find((t) => t.isDefault)?.id ?? rates[0]?.id ?? '';
  const t = initial?.template;
  const [f, setF] = useState({
    clientId: initial?.clientId ?? '', clientName: initial?.clientName ?? '', name: initial?.name ?? '', frequency: initial?.frequency ?? 'monthly', startDate: initial?.startDate ?? todayIso(), endDate: initial?.endDate ?? '',
    notes: t?.notes ?? '', globalDiscountPct: t?.globalDiscountPct ?? '0',
    lines: t?.lines?.map((l) => ({ description: l.description ?? '', quantity: String(l.quantity), unitPrice: String(l.unitPrice ?? '0'), discountPct: String(l.discountPct ?? '0'), taxRateId: l.taxRateId ?? def, productId: l.productId ?? null })) ?? [blankLine(def)],
  });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const setLine = (i, k, v) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const submit = async () => {
    setBusy(true); setError('');
    const body = { clientId: f.clientId, name: f.name, frequency: f.frequency, startDate: f.startDate, endDate: f.endDate || null,
      template: { globalDiscountPct: f.globalDiscountPct || '0', notes: f.notes || null, lines: f.lines.map((l) => ({ productId: l.productId || null, description: l.description || undefined, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct || '0', taxRateId: l.taxRateId || undefined })) } };
    try { onDone((initial ? await api.put(`/recurring-invoices/${initial.id}`, body) : await api.post('/recurring-invoices', body)).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  const locked = initial && initial.runCount > 0;
  return (
    <Modal title={initial ? 'Modifier la série' : 'Nouvelle facture récurrente'} onClose={onClose} size="lg">
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Combobox id="rec-client" label="Client *" placeholder="Rechercher un client…" value={f.clientName} fetcher={searchClients} render={(c) => ({ label: c.name })} onPick={(c) => setF({ ...f, clientId: c.id, clientName: c.name })} /></div>
          <div><label htmlFor="rec-name" className="mb-1 block text-sm font-medium">Nom de la série *</label><input id="rec-name" value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} className={field} placeholder="Ex. Maintenance mensuelle" /></div>
          <div><label htmlFor="rec-freq" className="mb-1 block text-sm font-medium">Fréquence</label><select id="rec-freq" disabled={locked} value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })} className={field}>{Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label htmlFor="rec-start" className="mb-1 block text-sm font-medium">Première échéance</label><input id="rec-start" type="date" disabled={locked} value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} className={field} /></div>
          <div><label htmlFor="rec-end" className="mb-1 block text-sm font-medium">Fin (optionnelle)</label><input id="rec-end" type="date" value={f.endDate ?? ''} onChange={(e) => setF({ ...f, endDate: e.target.value })} className={field} /></div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Lignes de la facture</h3><Button type="button" variant="secondary" onClick={() => setF({ ...f, lines: [...f.lines, blankLine(def)] })}><Plus size={14} aria-hidden /> Ligne</Button></div>
          {f.lines.map((l, i) => (
            <div key={i} className="grid gap-2 rounded-md border border-slate-200 p-2 sm:grid-cols-12" data-testid="rec-line">
              <input aria-label={`Désignation ligne ${i + 1}`} placeholder="Désignation" value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} className={`${field} sm:col-span-5`} />
              <input aria-label={`Quantité ligne ${i + 1}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} className={`${field} sm:col-span-1`} />
              <input aria-label={`Prix unitaire ligne ${i + 1}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, 'unitPrice', e.target.value)} className={`${field} sm:col-span-2`} />
              <select aria-label={`TVA ligne ${i + 1}`} value={l.taxRateId} onChange={(e) => setLine(i, 'taxRateId', e.target.value)} className={`${field} sm:col-span-3`}>{rates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              {f.lines.length > 1 && <Button type="button" variant="ghost" aria-label={`Supprimer la ligne ${i + 1}`} onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })}><Trash2 size={14} className="text-red-600" /></Button>}
            </div>
          ))}
        </div>
        <div><label htmlFor="rec-notes" className="mb-1 block text-sm font-medium">Notes de la facture</label><textarea id="rec-notes" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className={field} /></div>
        <p className="text-xs text-slate-500">À chaque échéance, MHFac crée un <strong>brouillon</strong> de facture avec ces lignes ; vous le relisez puis l'émettez. Rien n'est émis ni envoyé automatiquement. Les prix et la TVA sont ceux du modèle au moment de la génération.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={!f.clientId || f.name.trim().length < 2} onClick={submit}>{initial ? 'Enregistrer' : 'Créer la série'}</Button></div>
      </div>
    </Modal>
  );
}

export default function RecurringPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1); const [state, setState] = useState({ loading: true });
  const [taxRates, setTaxRates] = useState([]); const [form, setForm] = useState(null); const [open, setOpen] = useState(null); const [detail, setDetail] = useState(null);
  const [notice, setNotice] = useState({ tone: 'success', text: '' }); const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try { const r = await api.get('/recurring-invoices', { params: { status: status || undefined, page, limit: 15 } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); }
  }, [status, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/tax-rates').then((r) => setTaxRates(r.data.data)).catch(() => {}); }, []);
  const write = can('invoice.write');
  const act = async (key, fn, ok) => { setBusy(key); try { const r = await fn(); setNotice({ tone: 'success', text: typeof ok === 'function' ? ok(r) : ok }); await load(); if (open) setDetail((await api.get(`/recurring-invoices/${open}`)).data.data); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(''); } };
  const toggle = async (id) => { if (open === id) { setOpen(null); return; } setOpen(id); setDetail(null); try { setDetail((await api.get(`/recurring-invoices/${id}`)).data.data); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } };
  const edit = async (id) => { try { setForm((await api.get(`/recurring-invoices/${id}`)).data.data); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } };
  const runMsg = (r) => (r.data.data.generated ? `${r.data.data.generated} brouillon(s) de facture généré(s)` : 'Aucune échéance due');

  return (
    <>
      <PageHeader title="Factures récurrentes" subtitle="Abonnements, loyers, maintenance : un modèle génère un brouillon de facture à chaque échéance."
        actions={write && <div className="flex gap-2"><Button variant="secondary" loading={busy === 'due'} onClick={() => act('due', () => api.post('/recurring-invoices/run-due'), runMsg)}><Zap size={16} aria-hidden /> Générer les échéances dues</Button><Button onClick={() => setForm({})}><Plus size={16} aria-hidden /> Nouvelle série</Button></div>} />
      <div className="mb-4"><Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert></div>
      <Card>
        <div className="border-b border-slate-200 p-4"><select aria-label="Statut" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Tous les statuts</option><option value="active">Actives</option><option value="paused">En pause</option><option value="ended">Terminées</option></select></div>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={CalendarClock} title="Aucune facture récurrente" action={write && <Button onClick={() => setForm({})}><Plus size={16} aria-hidden /> Nouvelle série</Button>}>Créez un modèle : les brouillons seront générés à chaque échéance.</EmptyState>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Série</th><th className="px-4 py-3">Client</th><th className="px-4 py-3">Fréquence</th><th className="px-4 py-3">Prochaine échéance</th><th className="px-4 py-3">Générées</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3 text-right">Actions</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((r) => (
              <Fragment key={r.id}>
                <tr className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium"><button className="text-brand-700 hover:underline" onClick={() => toggle(r.id)} aria-expanded={open === r.id}>{r.name}</button></td>
                  <td className="px-4 py-3">{r.clientName}</td><td className="px-4 py-3">{FREQ[r.frequency]}</td><td className="px-4 py-3">{fmtDate(r.nextRunDate)}</td><td className="px-4 py-3 tabular-nums">{r.runCount}</td>
                  <td className="px-4 py-3"><Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge></td>
                  <td className="px-4 py-3"><div className="flex justify-end gap-1">{write && r.status !== 'ended' && <>
                    {r.status === 'active' && <Button variant="ghost" aria-label={`Générer maintenant ${r.name}`} title="Générer les échéances dues" loading={busy === `run${r.id}`} onClick={() => act(`run${r.id}`, () => api.post(`/recurring-invoices/${r.id}/run`), runMsg)}><Zap size={15} /></Button>}
                    {r.status === 'active' ? <Button variant="ghost" aria-label={`Mettre en pause ${r.name}`} title="Pause" onClick={() => act(`p${r.id}`, () => api.post(`/recurring-invoices/${r.id}/pause`), 'Série mise en pause')}><Pause size={15} /></Button>
                      : <Button variant="ghost" aria-label={`Reprendre ${r.name}`} title="Reprendre" onClick={() => act(`p${r.id}`, () => api.post(`/recurring-invoices/${r.id}/resume`), 'Série reprise')}><Play size={15} /></Button>}
                    <Button variant="ghost" aria-label={`Modifier ${r.name}`} title="Modifier" onClick={() => edit(r.id)}><Pencil size={15} /></Button>
                    <Button variant="ghost" aria-label={`Terminer ${r.name}`} title="Terminer la série" onClick={() => act(`e${r.id}`, () => api.post(`/recurring-invoices/${r.id}/end`), 'Série terminée')}><Square size={15} /></Button></>}
                    {write && r.runCount === 0 && can('invoice.delete') && <Button variant="ghost" aria-label={`Supprimer ${r.name}`} title="Supprimer" onClick={() => act(`d${r.id}`, () => api.delete(`/recurring-invoices/${r.id}`), 'Série supprimée')}><Trash2 size={15} className="text-red-600" /></Button>}</div></td>
                </tr>
                {open === r.id && <tr><td colSpan={7} className="bg-slate-50 px-4 py-3">{!detail ? <Spinner /> : detail.runs.length === 0 ? <p className="text-sm text-slate-500">Aucune facture générée pour l'instant.</p> : (
                  <ul className="space-y-1 text-sm" data-testid="rec-runs">{detail.runs.map((x) => <li key={x.invoiceId}>Échéance du {fmtDate(x.period)} · <Link className="text-brand-700 hover:underline" to={`/sales/invoices/${x.invoiceId}`}>{x.number ?? 'brouillon'}</Link> · {fmtMoney(x.totalTtc)} · {x.status === 'draft' ? 'à relire et émettre' : x.status === 'issued' ? 'émise' : 'annulée'}</li>)}</ul>)}</td></tr>}
              </Fragment>
            ))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={setPage} />
      </Card>
      {form && <RecurringForm initial={form.id ? form : null} taxRates={taxRates} onClose={() => setForm(null)} onDone={(r) => { setForm(null); setNotice({ tone: 'success', text: `Série « ${r.name} » enregistrée` }); load(); }} />}
    </>
  );
}
