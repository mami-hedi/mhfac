import { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowLeftRight, Landmark, Plus, RotateCcw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { Pagination } from '../masterdata/shared.jsx';
import { fmtDate, fmtMoney, todayIso } from '../sales/shared.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const Lbl = ({ id, children }) => <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">{children}</label>;
const KIND = { client_payment: 'Règlement client', supplier_payment: 'Règlement fournisseur', instrument: 'Chèque / effet', manual: 'Saisie manuelle', transfer: 'Virement interne' };
export const useAccounts = (status = 'active') => {
  const [accounts, setAccounts] = useState([]);
  useEffect(() => { api.get('/treasury/accounts', { params: { status } }).then((r) => setAccounts(r.data.data)).catch(() => {}); }, [status]);
  return accounts;
};
const neg = (v) => (String(v).startsWith('-') ? 'text-red-600' : '');

/* ───── Comptes ───── */
function AccountModal({ account, onClose, onDone }) {
  const [f, setF] = useState(account ? { code: account.code, name: account.name, type: account.type, currency: account.currency, bankName: account.bankName ?? '', accountNumber: account.accountNumber ?? '', openingBalance: account.openingBalance, openingDate: account.openingDate ?? '' }
    : { code: '', name: '', type: 'bank', currency: 'TND', bankName: '', accountNumber: '', openingBalance: '0', openingDate: todayIso() });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true); setError('');
    const body = { name: f.name, bankName: f.bankName || null, accountNumber: f.accountNumber || null };
    try {
      if (account) { await api.put(`/treasury/accounts/${account.id}`, { ...body, ...Object.fromEntries(['type', 'currency', 'openingBalance', 'openingDate'].filter((k) => String(f[k] ?? '') !== String(account[k] ?? '')).map((k) => [k, f[k]])) }); }
      else await api.post('/treasury/accounts', { ...body, code: f.code, type: f.type, currency: f.currency, openingBalance: f.openingBalance, openingDate: f.openingDate || undefined });
      onDone();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={account ? `Modifier ${account.code}` : 'Nouveau compte'} onClose={onClose}>
      <div className="space-y-3">
        <Alert tone="error">{error}</Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Lbl id="ac-code">Code *</Lbl><input id="ac-code" className={field} value={f.code} disabled={!!account} maxLength={20} onChange={set('code')} /></div>
          <div><Lbl id="ac-name">Nom *</Lbl><input id="ac-name" className={field} value={f.name} maxLength={120} onChange={set('name')} /></div>
          <div><Lbl id="ac-type">Type</Lbl><select id="ac-type" className={field} value={f.type} onChange={set('type')}><option value="bank">Banque</option><option value="cash">Caisse</option></select></div>
          <div><Lbl id="ac-cur">Devise</Lbl><input id="ac-cur" className={field} value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></div>
          <div><Lbl id="ac-bank">Banque</Lbl><input id="ac-bank" className={field} value={f.bankName} onChange={set('bankName')} /></div>
          <div><Lbl id="ac-num">N° de compte / RIB</Lbl><input id="ac-num" className={field} value={f.accountNumber} onChange={set('accountNumber')} /></div>
          <div><Lbl id="ac-open">Solde d'ouverture</Lbl><input id="ac-open" inputMode="decimal" className={field} value={f.openingBalance} onChange={set('openingBalance')} /></div>
          <div><Lbl id="ac-odate">Date d'ouverture</Lbl><input id="ac-odate" type="date" className={field} value={f.openingDate} onChange={set('openingDate')} /></div>
        </div>
        <p className="text-xs text-slate-500">Le solde, la date et la devise ne sont plus modifiables dès qu'une écriture existe.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={!f.name || !f.code} onClick={submit}>Enregistrer</Button></div>
      </div>
    </Modal>
  );
}

export function AccountsPage() {
  const { can } = useAuth();
  const [archived, setArchived] = useState(false); const [state, setState] = useState({ loading: true }); const [edit, setEdit] = useState(null); const [notice, setNotice] = useState('');
  const load = useCallback(async () => { try { const [a, s] = await Promise.all([api.get('/treasury/accounts', { params: { status: archived ? 'archived' : 'active' } }), api.get('/treasury/summary')]); setState({ rows: a.data.data, summary: s.data.data }); } catch (e) { setState({ error: errorMessage(e) }); } }, [archived]);
  useEffect(() => { load(); }, [load]);
  const toggle = async (a) => { try { await api.post(`/treasury/accounts/${a.id}/${a.status === 'active' ? 'archive' : 'restore'}`); load(); } catch (e) { setNotice(errorMessage(e)); } };
  return (
    <>
      <PageHeader title="Comptes bancaires et caisses" subtitle="Le solde est calculé par le serveur : solde d'ouverture + écritures non annulées."
        actions={can('treasury.write') && <Button onClick={() => setEdit({})}><Plus size={16} aria-hidden /> Nouveau compte</Button>} />
      <div className="mb-4"><Alert tone="error" onClose={() => setNotice('')}>{notice}</Alert></div>
      {state.summary && Object.keys(state.summary.byCurrency).length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">{Object.entries(state.summary.byCurrency).map(([cur, v]) => (
          <Card key={cur}><div className="p-4"><p className="text-xs uppercase text-slate-500">Trésorerie {cur}</p><p className={`text-2xl font-semibold tabular-nums ${neg(v.balance)}`}>{fmtMoney(v.balance, cur)}</p><p className="text-xs text-slate-500">Banques {fmtMoney(v.bank, cur)} · Caisses {fmtMoney(v.cash, cur)}</p></div></Card>))}</div>
      )}
      <Card>
        <div className="flex gap-3 border-b border-slate-200 p-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Afficher les comptes archivés</label></div>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={Landmark} title="Aucun compte">Créez un compte bancaire ou une caisse pour suivre votre trésorerie.</EmptyState>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Code</th><th className="px-4 py-3">Nom</th><th className="px-4 py-3">Type</th><th className="px-4 py-3 text-right">Solde</th><th className="px-4 py-3 text-right">Solde rapproché</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((a) => (
              <tr key={a.id}><td className="px-4 py-3 font-mono text-xs">{a.code}</td><td className="px-4 py-3 font-medium">{a.name}{a.bankName && <span className="text-xs text-slate-500"> · {a.bankName}</span>}</td>
                <td className="px-4 py-3">{a.type === 'bank' ? 'Banque' : 'Caisse'}</td>
                <td className={`px-4 py-3 text-right tabular-nums ${neg(a.balance)}`}>{fmtMoney(a.balance, a.currency)}</td><td className="px-4 py-3 text-right tabular-nums text-slate-500">{fmtMoney(a.reconciledBalance, a.currency)}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {can('treasury.write') && <Button variant="ghost" onClick={() => setEdit(a)}>Modifier</Button>}
                  {can('treasury.delete') && <Button variant="ghost" aria-label={`${a.status === 'active' ? 'Archiver' : 'Restaurer'} ${a.code}`} onClick={() => toggle(a)}>{a.status === 'active' ? <Archive size={15} /> : <RotateCcw size={15} />}</Button>}</td></tr>))}</tbody></table></div>
        )}
      </Card>
      {edit && <AccountModal account={edit.id ? edit : null} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
    </>
  );
}

/* ───── Transactions ───── */
function TxModal({ transfer, accounts, onClose, onDone }) {
  const [f, setF] = useState({ accountId: accounts[0]?.id ?? '', toAccountId: '', direction: 'in', date: todayIso(), amount: '', label: '', reference: '' });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true); setError('');
    try {
      if (transfer) await api.post('/treasury/transfers', { fromAccountId: f.accountId, toAccountId: f.toAccountId, date: f.date, amount: f.amount, label: f.label || undefined, reference: f.reference || undefined });
      else await api.post('/treasury/transactions', { accountId: f.accountId, date: f.date, direction: f.direction, amount: f.amount, label: f.label, reference: f.reference || undefined });
      onDone();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  const opts = accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name} ({a.currency})</option>);
  return (
    <Modal title={transfer ? 'Virement interne' : 'Écriture manuelle'} onClose={onClose}>
      <div className="space-y-3">
        <Alert tone="error">{error}</Alert>
        <div><Lbl id="tx-acc">{transfer ? 'Compte source *' : 'Compte *'}</Lbl><select id="tx-acc" className={field} value={f.accountId} onChange={set('accountId')}>{opts}</select></div>
        {transfer ? <div><Lbl id="tx-to">Compte destination *</Lbl><select id="tx-to" className={field} value={f.toAccountId} onChange={set('toAccountId')}><option value="">—</option>{opts}</select></div>
          : <div><Lbl id="tx-dir">Sens</Lbl><select id="tx-dir" className={field} value={f.direction} onChange={set('direction')}><option value="in">Entrée (encaissement)</option><option value="out">Sortie (décaissement)</option></select></div>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Lbl id="tx-date">Date *</Lbl><input id="tx-date" type="date" className={field} max={todayIso()} value={f.date} onChange={set('date')} /></div>
          <div><Lbl id="tx-amt">Montant *</Lbl><input id="tx-amt" inputMode="decimal" className={field} value={f.amount} onChange={set('amount')} /></div>
        </div>
        <div><Lbl id="tx-label">Libellé {transfer ? '' : '*'}</Lbl><input id="tx-label" className={field} value={f.label} maxLength={255} onChange={set('label')} placeholder={transfer ? 'Par défaut : Virement A → B' : 'Frais bancaires, apport…'} /></div>
        <div><Lbl id="tx-ref">Référence</Lbl><input id="tx-ref" className={field} value={f.reference} maxLength={120} onChange={set('reference')} /></div>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={!f.amount || !f.accountId || (transfer ? !f.toAccountId : f.label.trim().length < 2)} onClick={submit}>Enregistrer</Button></div>
      </div>
    </Modal>
  );
}

export function TransactionsPage() {
  const { can } = useAuth(); const accounts = useAccounts('active');
  const [f, setF] = useState({ accountId: '', kind: '', direction: '', status: 'recorded', reconciled: '', from: '', to: '', page: 1 });
  const [state, setState] = useState({ loading: true }); const [modal, setModal] = useState(null); const [cancel, setCancel] = useState(null); const [reason, setReason] = useState(''); const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const load = useCallback(async () => {
    try { const r = await api.get('/treasury/transactions', { params: { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')), limit: 15 } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); }
  }, [f]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF({ ...f, ...patch, page: 1 });
  const reconcile = async (t) => { try { await api.post('/treasury/transactions/reconcile', { ids: [t.id], reconciled: !t.reconciled }); load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } };
  const sel = 'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
  return (
    <>
      <PageHeader title="Transactions" subtitle="Journal de trésorerie. Une écriture n'est jamais supprimée : elle s'annule avec un motif. Les écritures issues d'un règlement s'annulent depuis le règlement."
        actions={can('treasury.write') && <div className="flex gap-2"><Button variant="secondary" onClick={() => setModal('transfer')}><ArrowLeftRight size={16} aria-hidden /> Virement interne</Button><Button onClick={() => setModal('manual')}><Plus size={16} aria-hidden /> Écriture manuelle</Button></div>} />
      <div className="mb-4"><Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert></div>
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <select aria-label="Compte" className={sel} value={f.accountId} onChange={(e) => set({ accountId: e.target.value })}><option value="">Tous les comptes</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select>
          <select aria-label="Nature" className={sel} value={f.kind} onChange={(e) => set({ kind: e.target.value })}><option value="">Toutes natures</option>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select aria-label="Sens" className={sel} value={f.direction} onChange={(e) => set({ direction: e.target.value })}><option value="">Entrées et sorties</option><option value="in">Entrées</option><option value="out">Sorties</option></select>
          <select aria-label="Rapprochement" className={sel} value={f.reconciled} onChange={(e) => set({ reconciled: e.target.value })}><option value="">Rapprochées ou non</option><option value="1">Rapprochées</option><option value="0">Non rapprochées</option></select>
          <select aria-label="Statut" className={sel} value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="recorded">Enregistrées</option><option value="cancelled">Annulées</option><option value="">Toutes</option></select>
          <input aria-label="Du" type="date" className={sel} value={f.from} onChange={(e) => set({ from: e.target.value })} /><input aria-label="Au" type="date" className={sel} value={f.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={Landmark} title="Aucune écriture">Les règlements avec compte, les chèques encaissés et vos saisies apparaissent ici.</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">N°</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Compte</th><th className="px-4 py-3">Libellé</th><th className="px-4 py-3 text-right">Entrée</th><th className="px-4 py-3 text-right">Sortie</th><th className="px-4 py-3">Rappr.</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((t) => (
              <tr key={t.id} className={t.status === 'cancelled' ? 'text-slate-400 line-through' : ''}>
                <td className="px-4 py-3 font-mono text-xs">{t.number}</td><td className="px-4 py-3">{fmtDate(t.date)}</td><td className="px-4 py-3">{t.account.name}</td>
                <td className="px-4 py-3">{t.label}<div className="text-xs text-slate-500">{KIND[t.kind]}{t.reference ? ` · ${t.reference}` : ''}{t.cancelReason ? ` · annulée : ${t.cancelReason}` : ''}</div></td>
                <td className="px-4 py-3 text-right tabular-nums">{t.direction === 'in' ? fmtMoney(t.amount, t.currency) : ''}</td><td className="px-4 py-3 text-right tabular-nums">{t.direction === 'out' ? fmtMoney(t.amount, t.currency) : ''}</td>
                <td className="px-4 py-3">{t.status === 'recorded' && <input type="checkbox" aria-label={`Rapprocher ${t.number}`} checked={t.reconciled} disabled={!can('treasury.validate')} onChange={() => reconcile(t)} />}</td>
                <td className="px-4 py-3 text-right">{t.status === 'recorded' && ['manual', 'transfer'].includes(t.kind) && can('treasury.validate') && <Button variant="ghost" onClick={() => { setCancel(t); setReason(''); }}>Annuler</Button>}</td></tr>))}</tbody>
            {state.meta && <tfoot className="border-t border-slate-200 bg-slate-50 text-sm font-medium"><tr><td className="px-4 py-3" colSpan={4}>Totaux (écritures enregistrées, filtre appliqué)</td><td className="px-4 py-3 text-right tabular-nums">{fmtMoney(state.meta.totalIn, '')}</td><td className="px-4 py-3 text-right tabular-nums">{fmtMoney(state.meta.totalOut, '')}</td><td colSpan={2} /></tr></tfoot>}
          </table></div>
        )}
        <Pagination meta={state.meta} onPage={(page) => setF({ ...f, page })} />
      </Card>
      {modal && <TxModal transfer={modal === 'transfer'} accounts={accounts} onClose={() => setModal(null)} onDone={() => { setModal(null); setNotice({ tone: 'success', text: 'Écriture enregistrée' }); load(); }} />}
      {cancel && (
        <Modal title={`Annuler ${cancel.number}`} onClose={() => setCancel(null)}>
          <p className="mb-3 text-sm text-slate-600">{cancel.kind === 'transfer' ? 'Les deux écritures du virement sont annulées.' : "L'écriture est conservée avec son motif."}</p>
          <input aria-label="Motif d'annulation" className={field} value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} placeholder="Motif (obligatoire)" />
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setCancel(null)}>Retour</Button>
            <Button variant="danger" disabled={reason.trim().length < 5} onClick={async () => { try { await api.post(`/treasury/transactions/${cancel.id}/cancel`, { reason }); setNotice({ tone: 'success', text: `${cancel.number} annulée` }); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } setCancel(null); load(); }}>Annuler l'écriture</Button></div>
        </Modal>
      )}
    </>
  );
}

/* ───── Chèques et traites ───── */
const INS_ST = { pending: ['En portefeuille', 'neutral'], deposited: ['Remis en banque', 'blue'], cleared: ['Encaissé / débité', 'green'], bounced: ['Impayé', 'red'], cancelled: ['Annulé', 'neutral'] };
export function InstrumentsPage() {
  const { can } = useAuth(); const accounts = useAccounts('active');
  const [f, setF] = useState({ direction: '', type: '', status: '', overdue: '', page: 1 }); const [state, setState] = useState({ loading: true });
  const [act, setAct] = useState(null); const [date, setDate] = useState(todayIso()); const [accountId, setAccountId] = useState(''); const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const load = useCallback(async () => { try { const r = await api.get('/treasury/instruments', { params: { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')), limit: 15 } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); } }, [f]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF({ ...f, ...patch, page: 1 });
  const open = (kind, i) => { setAct({ kind, i }); setDate(todayIso()); setAccountId(i.account?.id ?? ''); setReason(''); setError(''); };
  const run = async () => {
    try { await api.post(`/treasury/instruments/${act.i.id}/${act.kind}`, { date, ...(act.kind === 'bounce' ? { reason } : accountId ? { accountId } : {}) }); setNotice(''); setAct(null); load(); } catch (e) { setError(errorMessage(e)); }
  };
  const sel = 'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
  const TITLES = { deposit: 'Remettre en banque', clear: 'Constater l\'encaissement', bounce: 'Déclarer impayé' };
  return (
    <>
      <PageHeader title="Chèques & traites" subtitle="Portefeuille des chèques et effets reçus (clients) et émis (fournisseurs). Le compte n'est mouvementé qu'à l'encaissement. Un impayé annule le règlement et rouvre la facture." />
      <div className="mb-4"><Alert tone="error" onClose={() => setNotice('')}>{notice}</Alert></div>
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <select aria-label="Sens" className={sel} value={f.direction} onChange={(e) => set({ direction: e.target.value })}><option value="">Reçus et émis</option><option value="received">Reçus (clients)</option><option value="issued">Émis (fournisseurs)</option></select>
          <select aria-label="Type" className={sel} value={f.type} onChange={(e) => set({ type: e.target.value })}><option value="">Chèques et effets</option><option value="cheque">Chèques</option><option value="bill">Effets de commerce</option></select>
          <select aria-label="Statut" className={sel} value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="">Tous statuts</option>{Object.entries(INS_ST).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.overdue === '1'} onChange={(e) => set({ overdue: e.target.checked ? '1' : '' })} /> Échus uniquement</label>
        </div>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={Landmark} title="Aucun chèque ni effet">Ils apparaissent quand un règlement est enregistré par chèque ou effet de commerce.</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Sens</th><th className="px-4 py-3">Type / N°</th><th className="px-4 py-3">Tiers</th><th className="px-4 py-3">Échéance</th><th className="px-4 py-3 text-right">Montant</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((i) => (
              <tr key={i.id}><td className="px-4 py-3">{i.direction === 'received' ? 'Reçu' : 'Émis'}</td>
                <td className="px-4 py-3">{i.type === 'cheque' ? 'Chèque' : 'Effet'} <span className="font-mono text-xs">{i.number}</span>{i.bankName && <span className="text-xs text-slate-500"> · {i.bankName}</span>}<div className="text-xs text-slate-500">Règlement {i.payment.number}</div></td>
                <td className="px-4 py-3">{i.partyName}</td><td className="px-4 py-3">{fmtDate(i.dueDate)}{i.overdue && <span className="ml-1 text-xs text-red-600">échu</span>}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(i.amount, i.currency)}</td><td className="px-4 py-3"><Badge tone={INS_ST[i.status][1]}>{INS_ST[i.status][0]}</Badge></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">{can('treasury.validate') && (<>
                  {i.direction === 'received' && i.status === 'pending' && <Button variant="ghost" onClick={() => open('deposit', i)}>Remettre</Button>}
                  {['pending', 'deposited'].includes(i.status) && <Button variant="ghost" onClick={() => open('clear', i)}>Encaisser</Button>}
                  {i.direction === 'received' && ['pending', 'deposited'].includes(i.status) && <Button variant="ghost" onClick={() => open('bounce', i)}>Impayé</Button>}</>)}</td></tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(page) => setF({ ...f, page })} />
      </Card>
      {act && (
        <Modal title={`${TITLES[act.kind]} — ${act.i.number}`} onClose={() => setAct(null)}>
          <div className="space-y-3"><Alert tone="error">{error}</Alert>
            <div><Lbl id="ins-date">Date *</Lbl><input id="ins-date" type="date" className={field} value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></div>
            {act.kind !== 'bounce' && <div><Lbl id="ins-acc">Compte {act.kind === 'clear' ? '*' : ''}</Lbl><select id="ins-acc" className={field} value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">—</option>{accounts.filter((a) => a.currency === act.i.currency).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></div>}
            {act.kind === 'bounce' && <><Alert tone="info">Le règlement lié sera annulé et la facture redeviendra impayée. Action définitive.</Alert><div><Lbl id="ins-reason">Motif *</Lbl><input id="ins-reason" className={field} value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} placeholder="Provision insuffisante…" /></div></>}
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setAct(null)}>Retour</Button><Button variant={act.kind === 'bounce' ? 'danger' : 'primary'} disabled={act.kind === 'bounce' ? reason.trim().length < 5 : act.kind === 'clear' && !accountId} onClick={run}>Confirmer</Button></div></div>
        </Modal>
      )}
    </>
  );
}
