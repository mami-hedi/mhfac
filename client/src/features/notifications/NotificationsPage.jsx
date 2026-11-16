// « Mes notifications » : liste (toutes / non lues) et préférences par type. Les préférences sont personnelles et propres à l'entreprise active.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { cn } from '../../utils/format.js';
import { SEVERITY_DOT, timeAgo } from './common.js';

const PAGE = 20;

function NotificationList() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('all'); const [rows, setRows] = useState(null); const [meta, setMeta] = useState({ total: 0, unread: 0 }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async (offset = 0) => {
    try {
      const r = await api.get('/notifications', { params: { status, limit: PAGE, offset } });
      setRows((prev) => (offset ? [...(prev ?? []), ...r.data.data] : r.data.data)); setMeta(r.data.meta); setError('');
    } catch (e) { setError(errorMessage(e)); setRows((p) => p ?? []); }
  }, [status]);
  useEffect(() => { setRows(null); load(0); }, [load]);
  const open = async (n) => { if (!n.read) await api.post(`/notifications/${n.id}/read`).catch(() => {}); if (n.link) navigate(n.link); else load(0); };
  const readAll = async () => { setBusy(true); await api.post('/notifications/read-all').catch((e) => setError(errorMessage(e))); await load(0); setBusy(false); };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 text-sm" role="tablist" aria-label="Filtre">
          {[['all', 'Toutes'], ['unread', `Non lues${meta.unread ? ` (${meta.unread})` : ''}`]].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={status === k} onClick={() => setStatus(k)} className={cn('rounded px-3 py-1.5', status === k ? 'bg-brand-600 font-medium text-white' : 'text-slate-600 hover:bg-slate-100')}>{l}</button>))}
        </div>
        <Button variant="secondary" disabled={!meta.unread} loading={busy} onClick={readAll}>Tout marquer comme lu</Button>
      </div>
      {error && <div className="mb-3"><Alert tone="error">{error}</Alert></div>}
      <Card>
        {rows === null ? <Spinner /> : rows.length === 0 ? <EmptyState icon={Bell} title={status === 'unread' ? 'Tout est à jour' : 'Aucune notification'}>Les alertes sur vos factures, votre stock et votre abonnement apparaîtront ici.</EmptyState> : (
          <ul className="divide-y divide-slate-100">{rows.map((n) => (
            <li key={n.id}>
              <button onClick={() => open(n)} className={cn('flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50', !n.read && 'bg-brand-50/50')}>
                <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', n.read ? 'bg-slate-200' : SEVERITY_DOT[n.severity])} aria-hidden />
                <span className="min-w-0 flex-1"><span className={cn('block text-sm text-slate-900', !n.read && 'font-semibold')}>{n.title}</span>
                  {n.body && <span className="block text-sm text-slate-600">{n.body}</span>}</span>
                <span className="shrink-0 text-xs text-slate-400">{timeAgo(n.createdAt)}</span>
              </button>
            </li>))}</ul>
        )}
        {rows && rows.length < meta.total && <div className="border-t border-slate-100 p-3 text-center"><Button variant="ghost" onClick={() => load(rows.length)}>Afficher plus</Button></div>}
      </Card>
    </>
  );
}

function Preferences() {
  const [state, setState] = useState({ loading: true }); const [saving, setSaving] = useState(''); const [notice, setNotice] = useState({ tone: 'success', text: '' });
  useEffect(() => { api.get('/notifications/preferences').then((r) => setState({ rows: r.data.data })).catch((e) => setState({ error: errorMessage(e) })); }, []);
  const toggle = async (p) => {
    setSaving(p.type); setNotice({ tone: 'success', text: '' });
    try { await api.put('/notifications/preferences', { preferences: { [p.type]: !p.enabled } }); setState((s) => ({ rows: s.rows.map((x) => (x.type === p.type ? { ...x, enabled: !p.enabled } : x)) })); setNotice({ tone: 'success', text: 'Préférence enregistrée.' }); }
    catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); }
    setSaving('');
  };
  if (state.loading) return <Spinner />;
  if (state.error) return <Alert tone="error">{state.error}</Alert>;
  const groups = state.rows.reduce((m, p) => { (m[p.categoryLabel] ??= []).push(p); return m; }, {});
  return (
    <>
      <p className="mb-3 text-sm text-slate-600">Choisissez les alertes que vous voulez voir. Vous ne recevez que celles qui concernent votre rôle. Elles s'affichent dans l'application (cloche) : aucun e-mail n'est envoyé.</p>
      <div className="mb-3"><Alert tone={notice.tone}>{notice.text}</Alert></div>
      <div className="space-y-4">{Object.entries(groups).map(([cat, items]) => (
        <Card key={cat} className="p-5">
          <h2 className="mb-3 font-semibold text-slate-900">{cat}</h2>
          <ul className="divide-y divide-slate-100">{items.map((p) => (
            <li key={p.type} className="flex items-center justify-between gap-3 py-2.5">
              <label htmlFor={`np-${p.type}`} className="text-sm text-slate-800">{p.label}</label>
              <input id={`np-${p.type}`} type="checkbox" role="switch" className="h-5 w-5" checked={p.enabled} disabled={saving === p.type} onChange={() => toggle(p)} />
            </li>))}</ul>
        </Card>))}</div>
    </>
  );
}

export default function NotificationsPage() {
  const [params, setParams] = useSearchParams(); const tab = params.get('tab') === 'preferences' ? 'preferences' : 'list';
  return (
    <>
      <PageHeader title="Mes notifications" subtitle="Alertes sur vos factures, votre stock et votre abonnement, selon votre rôle." />
      <div className="mb-4 flex gap-1 border-b border-slate-200" role="tablist">
        {[['list', 'Notifications'], ['preferences', 'Préférences']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setParams(k === 'list' ? {} : { tab: k })} className={cn('-mb-px border-b-2 px-4 py-2 text-sm', tab === k ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')}>{l}</button>))}
      </div>
      {tab === 'list' ? <NotificationList /> : <Preferences />}
    </>
  );
}
