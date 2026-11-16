import { useCallback, useEffect, useState } from 'react';
import { BellRing, Mail } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { fmtDate, fmtMoney } from '../sales/shared.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';

export default function RemindersPage() {
  const { can } = useAuth();
  const [state, setState] = useState({ loading: true }); const [history, setHistory] = useState([]); const [send, setSend] = useState(null);
  const [to, setTo] = useState(''); const [message, setMessage] = useState(''); const [force, setForce] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try { const [o, h] = await Promise.all([api.get('/reminders/overdue'), api.get('/reminders/history')]); setState({ rows: o.data.data }); setHistory(h.data.data); } catch (e) { setState({ error: errorMessage(e) }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const open = (g) => { setSend(g); setTo(g.client.email ?? ''); setMessage(''); setForce(false); setError(''); };
  const submit = async () => {
    setBusy(true); setError('');
    try { await api.post('/reminders/send', { clientId: send.client.id, to: to.split(/[,;\s]+/).filter(Boolean), message: message || undefined, force }); setNotice(`Relance envoyée à ${send.client.name}`); setSend(null); load(); }
    catch (e) { setError(errorMessage(e)); if (e?.response?.data?.error?.code === 'RECENT_REMINDER') setForce(true); }
    setBusy(false);
  };
  return (
    <>
      <PageHeader title="Relances clients" subtitle="Factures émises dont l'échéance est dépassée et dont le solde reste dû. Chaque relance est journalisée ; une seule relance par client toutes les 24 h, sauf confirmation explicite." />
      <div className="mb-4"><Alert tone="success" onClose={() => setNotice('')}>{notice}</Alert></div>
      <Card>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={BellRing} title="Aucune facture en retard">Toutes vos factures échues sont réglées.</EmptyState> : (
          <div className="divide-y divide-slate-100">{state.rows.map((g) => (
            <div key={g.client.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="font-medium text-slate-900">{g.client.name} <span className="text-xs font-normal text-slate-500">{g.client.email ?? 'pas d\'e-mail'}</span></p>
                  <p className="text-xs text-slate-500">{g.invoices.length} facture(s) · jusqu'à {g.maxDaysLate} j de retard · {g.reminderCount ? `${g.reminderCount} relance(s), dernière le ${fmtDate(String(g.lastReminderAt).slice(0, 10))}` : 'jamais relancé'}</p></div>
                <div className="flex items-center gap-3"><strong className="tabular-nums">{Object.entries(g.totals).map(([c, t]) => fmtMoney(t, c)).join(' + ')}</strong>
                  {can('payment.write') && <Button variant="secondary" onClick={() => open(g)}><Mail size={15} aria-hidden /> Relancer</Button>}</div></div>
              <table className="mt-2 w-full text-sm"><tbody>{g.invoices.map((i) => <tr key={i.id} className="text-slate-600"><td className="py-1 font-mono text-xs">{i.number}</td><td>échue le {fmtDate(i.dueDate)}</td><td><Badge tone="red">{i.daysLate} j</Badge></td><td className="text-right tabular-nums">{fmtMoney(i.balance, i.currency)}</td></tr>)}</tbody></table>
            </div>))}</div>
        )}
      </Card>
      {history.length > 0 && (
        <Card className="mt-4"><div className="border-b border-slate-200 p-4 text-sm font-medium">Historique des relances</div>
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><tbody className="divide-y divide-slate-100">{history.map((h, k) => (
            <tr key={k}><td className="px-4 py-2">{fmtDate(String(h.at).slice(0, 10))}</td><td className="px-4 py-2">{h.client.name}</td><td className="px-4 py-2 text-xs text-slate-500">{h.invoices}</td><td className="px-4 py-2 text-right tabular-nums">{fmtMoney(h.total, h.currency)}</td><td className="px-4 py-2"><Badge tone={h.status === 'sent' ? 'green' : 'red'}>{h.status === 'sent' ? 'Envoyée' : 'Échec'}</Badge></td></tr>))}</tbody></table></div></Card>
      )}
      {send && (
        <Modal title={`Relancer ${send.client.name}`} onClose={() => setSend(null)}>
          <div className="space-y-3"><Alert tone="error">{error}</Alert>
            <div><label htmlFor="rem-to" className="mb-1 block text-sm font-medium text-slate-700">Destinataire(s) *</label><input id="rem-to" className={field} value={to} onChange={(e) => setTo(e.target.value)} placeholder="a@client.tn, b@client.tn" /></div>
            <div><label htmlFor="rem-msg" className="mb-1 block text-sm font-medium text-slate-700">Message personnalisé (optionnel)</label><textarea id="rem-msg" rows={4} className={field} value={message} maxLength={3000} onChange={(e) => setMessage(e.target.value)} placeholder="Laissez vide pour le texte standard ; la liste des factures est ajoutée automatiquement." /></div>
            {force && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked readOnly /> Envoyer malgré la relance récente</label>}
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setSend(null)}>Annuler</Button><Button loading={busy} disabled={!to.trim()} onClick={submit}>{force ? 'Envoyer quand même' : 'Envoyer la relance'}</Button></div></div>
        </Modal>
      )}
    </>
  );
}
