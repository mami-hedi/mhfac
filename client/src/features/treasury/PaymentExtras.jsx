import { useEffect, useState } from 'react';
import { api } from '../../services/api.js';
import { todayIso } from '../sales/shared.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
// Champs trésorerie communs aux règlements client / fournisseur : compte, montant réellement versé (excédent = avance), échéance et banque pour chèque/effet.
export const emptyExtras = { accountId: '', received: '', dueDate: '', bankName: '' };
export const extrasBody = (x, method) => ({
  accountId: x.accountId || null, ...(x.received ? { amount: x.received } : {}),
  ...(['cheque', 'bill_of_exchange'].includes(method) ? { dueDate: x.dueDate || null, bankName: x.bankName || null } : {}),
});
export default function PaymentExtras({ value, onChange, method, currency = 'TND', party = 'client' }) {
  const [accounts, setAccounts] = useState([]);
  useEffect(() => { api.get('/treasury/accounts', { params: { status: 'active' } }).then((r) => setAccounts(r.data.data)).catch(() => setAccounts([])); }, []);
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const instrument = ['cheque', 'bill_of_exchange'].includes(method);
  return (
    <div className="grid gap-4 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
      <div><label htmlFor="pay-acc" className="mb-1 block text-sm font-medium text-slate-700">Compte de trésorerie</label>
        <select id="pay-acc" className={field} value={value.accountId} onChange={set('accountId')}><option value="">— Non suivi en trésorerie —</option>{accounts.filter((a) => a.currency === currency).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select>
        <p className="mt-1 text-xs text-slate-500">{instrument ? 'Le compte n\'est mouvementé qu\'à l\'encaissement du chèque / de l\'effet.' : 'Le compte est mouvementé immédiatement.'}</p></div>
      <div><label htmlFor="pay-received" className="mb-1 block text-sm font-medium text-slate-700">{party === 'client' ? 'Montant reçu' : 'Montant versé'} (optionnel)</label>
        <input id="pay-received" inputMode="decimal" className={field} value={value.received} onChange={set('received')} placeholder="= total affecté" />
        <p className="mt-1 text-xs text-slate-500">Si supérieur au total affecté, l'excédent reste en avance, à affecter plus tard.</p></div>
      {instrument && <>
        <div><label htmlFor="pay-due" className="mb-1 block text-sm font-medium text-slate-700">Échéance</label><input id="pay-due" type="date" min={todayIso()} className={field} value={value.dueDate} onChange={set('dueDate')} /></div>
        <div><label htmlFor="pay-bank" className="mb-1 block text-sm font-medium text-slate-700">Banque</label><input id="pay-bank" className={field} maxLength={120} value={value.bankName} onChange={set('bankName')} /></div></>}
    </div>
  );
}
