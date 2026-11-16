import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FileCheck2, RefreshCw, Send } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { fmtDate, fmtMoney } from '../sales/shared.jsx';

export const SIM_NOTICE = 'SIMULATION — non homologué TTN : MHFac n\'est ni conforme, ni connecté à TTN ni à une plateforme officielle. Ces transmissions n\'ont aucune valeur fiscale.';
const TONE = { preparing: 'neutral', pending: 'blue', transmitted: 'blue', accepted: 'green', rejected: 'red', error: 'red', retry: 'orange' };
const LABEL = { preparing: 'En préparation', pending: 'En attente de transmission', transmitted: 'Transmise', accepted: 'Acceptée', rejected: 'Rejetée', error: 'En erreur', retry: 'À réessayer' };
const SUBMITTABLE = ['pending', 'retry', 'error'];
const SCEN = { accept: 'Accepter (cas nominal)', reject: 'Rejeter (simule un rejet)', network_error: 'Erreur réseau (simule un délai dépassé)' };
const EVENTS = { created: 'Création', prepared: 'Document préparé et signé (simulation)', sent: 'Envoyée', retry_sent: 'Nouvelle tentative envoyée', failed: 'Échec', response_accepted: 'Accusé : acceptée', response_rejected: 'Accusé : rejetée', response_transmitted: 'Accusé : transmise' };
export const StatusPill = ({ status }) => <Badge tone={TONE[status]}>{LABEL[status] ?? status}</Badge>;
export const SimBadge = () => <Badge tone="orange">SIMULATION</Badge>;
const field = 'rounded-md border border-slate-300 px-3 py-2 text-sm';

export function EInvoicePage() {
  const { can } = useAuth(); const [state, setState] = useState({ loading: true }); const [cfg, setCfg] = useState(null); const [status, setStatus] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try { const [t, c] = await Promise.all([api.get('/e-invoicing/transmissions', { params: { status: status || undefined, limit: 100 } }), api.get('/e-invoicing/config')]); setState({ rows: t.data.data, by: t.data.meta.byStatus }); setCfg(c.data.data); } catch (e) { setState({ error: errorMessage(e) }); }
  }, [status]);
  useEffect(() => { load(); }, [load]);
  const act = async (path, label) => { setError(''); setNotice(''); try { await api.post(path); setNotice(label); load(); } catch (e) { setError(errorMessage(e)); } };
  const setScenario = async (scenario) => { setError(''); try { await api.put('/e-invoicing/config', { scenario }); setNotice('Scénario de test mis à jour'); load(); } catch (e) { setError(errorMessage(e)); } };
  return (
    <>
      <PageHeader title="Facturation électronique" subtitle="Cycle de vie des factures transmises (préparation, transmission, accusé, rejet, nouvelle tentative)." />
      <div className="mb-4 space-y-2"><Alert tone="info">{SIM_NOTICE}</Alert><Alert tone="error">{error}</Alert><Alert tone="success" onClose={() => setNotice('')}>{notice}</Alert></div>
      {cfg && (
        <Card className="mb-4 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-3"><SimBadge /><span>Fournisseur : <strong>Simulation (tests)</strong></span>
            {can('einvoice.write') && <label className="flex items-center gap-2">Scénario de test <select className={field} value={cfg.scenario} onChange={(e) => setScenario(e.target.value)}>{Object.entries(SCEN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
            {can('einvoice.validate') && <Button variant="secondary" onClick={() => act('/e-invoicing/retry-due', 'Relance des transmissions échues effectuée')}><RefreshCw size={15} aria-hidden /> Relancer les échues</Button>}</div>
          <p className="mt-2 text-xs text-slate-500">{cfg.providers.filter((p) => !p.available).map((p) => `${p.label} : ${p.reason}`).join(' ')}</p>
        </Card>
      )}
      <div className="mb-3 flex flex-wrap gap-2 text-sm"><button className={`rounded-full border px-3 py-1 ${!status ? 'bg-brand-50 border-brand-500' : ''}`} onClick={() => setStatus('')}>Toutes</button>
        {Object.keys(LABEL).map((s) => <button key={s} className={`rounded-full border px-3 py-1 ${status === s ? 'bg-brand-50 border-brand-500' : ''}`} onClick={() => setStatus(s)}>{LABEL[s]}{state.by?.[s] ? ` (${state.by[s]})` : ''}</button>)}</div>
      <Card>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={FileCheck2} title="Aucune transmission">Ouvrez une facture émise et utilisez « Préparer l'envoi électronique (simulation) ».</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Facture</th><th className="px-4 py-2">Client</th><th className="px-4 py-2">Date</th><th className="px-4 py-2 text-right">TTC</th><th className="px-4 py-2">Statut</th><th className="px-4 py-2">Essais</th><th className="px-4 py-2" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((t) => (
              <tr key={t.id}><td className="px-4 py-2 font-mono text-xs"><Link className="underline" to={`/e-invoicing/${t.id}`}>{t.invoice.number}</Link> <SimBadge /></td><td className="px-4 py-2">{t.invoice.clientName}</td><td className="px-4 py-2">{fmtDate(t.invoice.date)}</td><td className="px-4 py-2 text-right tabular-nums">{fmtMoney(t.invoice.totalTtc, t.invoice.currency)}</td><td className="px-4 py-2"><StatusPill status={t.status} /></td><td className="px-4 py-2">{t.attempts}</td>
                <td className="px-4 py-2 text-right">{can('einvoice.validate') && SUBMITTABLE.includes(t.status) && <Button variant="secondary" onClick={() => act(`/e-invoicing/transmissions/${t.id}/${t.status === 'pending' ? 'submit' : 'retry'}`, `Facture ${t.invoice.number} : traitée`)}><Send size={14} aria-hidden /> {t.status === 'pending' ? 'Transmettre' : 'Réessayer'}</Button>}</td></tr>))}</tbody></table></div>
        )}
      </Card>
    </>
  );
}

export function EInvoiceDetailPage() {
  const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth(); const [d, setD] = useState(null); const [error, setError] = useState('');
  const load = useCallback(async () => { try { setD((await api.get(`/e-invoicing/transmissions/${id}`)).data.data); } catch (e) { setError(errorMessage(e)); } }, [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (p) => { setError(''); try { await api.post(`/e-invoicing/transmissions/${id}/${p}`); load(); } catch (e) { setError(errorMessage(e)); } };
  if (error && !d) return <Alert tone="error">{error}</Alert>;
  if (!d) return <Spinner />;
  return (
    <>
      <PageHeader title={`Transmission — ${d.invoice.number}`} subtitle={<span className="inline-flex items-center gap-2"><StatusPill status={d.status} /><SimBadge />{d.providerReference && <span className="font-mono text-xs">{d.providerReference}</span>}</span>}
        actions={<div className="flex gap-2"><Button variant="secondary" onClick={() => navigate('/e-invoicing')}>Retour</Button>
          {can('einvoice.validate') && SUBMITTABLE.includes(d.status) && <Button onClick={() => act(d.status === 'pending' ? 'submit' : 'retry')}><Send size={15} aria-hidden /> {d.status === 'pending' ? 'Transmettre' : 'Réessayer'}</Button>}
          {can('einvoice.validate') && d.status === 'transmitted' && <Button variant="secondary" onClick={() => act('refresh')}><RefreshCw size={15} aria-hidden /> Actualiser</Button>}</div>} />
      <div className="mb-4 space-y-2"><Alert tone="info">{SIM_NOTICE}</Alert><Alert tone="error">{error || (d.lastError ? `Dernière erreur : ${d.lastError}` : '')}</Alert></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5"><h2 className="mb-3 text-sm font-semibold">Historique</h2><ol className="space-y-2 text-sm">{d.events.map((e, k) => <li key={k} className="border-l-2 border-slate-200 pl-3"><p className="font-medium">{EVENTS[e.event] ?? e.event}{e.to ? <> → <StatusPill status={e.to} /></> : null}</p><p className="text-xs text-slate-500">{new Date(e.at).toLocaleString('fr-FR')}{e.by ? ` · ${e.by}` : ''}{e.detail?.attempt ? ` · essai ${e.detail.attempt}` : ''}{e.detail?.error ? ` · ${e.detail.error}` : ''}</p></li>)}</ol></Card>
        <Card className="p-5"><h2 className="mb-1 text-sm font-semibold">Document préparé (format interne de simulation)</h2><p className="mb-2 text-xs text-slate-500">Empreinte : <span className="font-mono">{d.payloadHash.slice(0, 16)}…</span> · signature : {d.signatureStatus === 'simulated' ? 'simulée (sans valeur légale)' : d.signatureStatus}</p>
          <pre className="max-h-96 overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(d.payload, null, 2)}</pre></Card>
      </div>
      <p className="mt-3 text-sm"><Link className="underline" to={`/sales/${d.invoice.kind === 'credit_note' ? 'credit-notes' : 'invoices'}/${d.invoice.id}`}>Voir la facture</Link></p>
    </>
  );
}

// Encart affiché sur la fiche d'une facture émise.
export function InvoiceEInvoicePanel({ invoiceId }) {
  const { can } = useAuth(); const [t, setT] = useState(undefined); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setT((await api.get(`/e-invoicing/invoices/${invoiceId}`)).data.data); } catch { setT(null); } }, [invoiceId]);
  useEffect(() => { if (can('einvoice.read')) load(); }, [load, can]);
  if (!can('einvoice.read') || t === undefined) return null;
  const prepare = async () => { setBusy(true); setError(''); try { await api.post(`/e-invoicing/invoices/${invoiceId}/prepare`); await load(); } catch (e) { setError(errorMessage(e)); } setBusy(false); };
  return (
    <Card className="p-5"><h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">Facturation électronique <SimBadge /></h2>
      <Alert tone="error">{error}</Alert>
      {t ? <p className="text-sm"><StatusPill status={t.status} /> <Link className="ml-2 underline" to={`/e-invoicing/${t.id}`}>Détail</Link></p>
        : <><p className="mb-2 text-xs text-slate-500">Non préparée. Fonction de simulation : non homologuée TTN.</p>{can('einvoice.write') && <Button variant="secondary" loading={busy} onClick={prepare}>Préparer l'envoi électronique (simulation)</Button>}</>}
    </Card>
  );
}
