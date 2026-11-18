import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Modal, Select } from '../../components/ui/index.jsx';
import PaymentExtras, { emptyExtras, extrasBody } from '../treasury/PaymentExtras.jsx';
import { Combobox, fmtDate, fmtMoney, searchClients, todayIso } from '../sales/shared.jsx';

export const METHOD_LABELS = { cash: 'Espèces', cheque: 'Chèque', bank_transfer: 'Virement', card: 'Carte bancaire', bill_of_exchange: 'Effet de commerce', other: 'Autre', withholding: 'Retenue à la source' };
// Somme exacte en millimes (entiers) : jamais de flottant pour un montant.
const toMil = (s) => { const v = String(s ?? '').trim().replace(',', '.'); if (!/^\d+(\.\d{1,3})?$/.test(v)) return null; const [i, f = ''] = v.split('.'); return BigInt(i) * 1000n + BigInt(f.padEnd(3, '0')); };
const fromMil = (n) => `${n / 1000n}.${String(n % 1000n).padStart(3, '0')}`;

// Règlement : le client choisi charge ses factures ouvertes ; le serveur reste l'autorité (solde, devise, doublons).
export default function PaymentModal({ client: fixedClient, invoice, onClose, onDone }) {
  const [client, setClient] = useState(fixedClient ?? null);
  const [open, setOpen] = useState([]); const [loading, setLoading] = useState(false);
  const [amounts, setAmounts] = useState({});
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [extras, setExtras] = useState(emptyExtras);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!client) { setOpen([]); return; }
    setLoading(true);
    api.get('/invoices', { params: { clientId: client.id, open: 1, limit: 100 } }).then((r) => {
      const rows = r.data.data; setOpen(rows);
      setAmounts(invoice ? { [invoice.id]: invoice.balance } : {});
    }).catch((e) => setError(errorMessage(e))).finally(() => setLoading(false));
  }, [client, invoice]);

  const total = useMemo(() => Object.values(amounts).reduce((s, v) => s + (toMil(v) ?? 0n), 0n), [amounts]);
  const submit = async () => {
    setError('');
    const allocations = open.filter((i) => (toMil(amounts[i.id]) ?? 0n) > 0n).map((i) => ({ invoiceId: i.id, amount: amounts[i.id] }));
    if (!allocations.length && !toMil(extras.received)) { setError('Saisissez un montant pour au moins une facture, ou le montant reçu (avance).'); return; }
    setBusy(true);
    try { onDone((await api.post('/payments', { clientId: client.id, date, method, reference: reference || null, notes: notes || null, allocations, ...extrasBody(extras, method) })).data.data); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  };

  return (
    <Modal title="Enregistrer un règlement" onClose={onClose} size="lg">
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <Combobox id="pay-client" label="Client *" placeholder="Rechercher un client…" fetcher={searchClients} disabled={!!fixedClient} value={client?.name}
          render={(c) => ({ label: c.name, node: <span>{c.name} <span className="text-xs text-slate-400">{c.code}</span></span> })} onPick={(c) => { setClient(c); setAmounts({}); }} />
        {client && loading && <p className="text-sm text-slate-500" role="status">Chargement des factures…</p>}
        {client && !loading && (open.length === 0 ? <p className="text-sm text-slate-500">Aucune facture en attente de règlement pour ce client.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2">Facture</th><th className="py-2">Échéance</th><th className="py-2 text-right">Solde</th><th className="py-2 text-right">Montant réglé</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{open.map((i) => (
                <tr key={i.id}>
                  <td className="py-2">{i.number}</td><td className="py-2">{fmtDate(i.dueDate)}{i.overdue && <span className="ml-1 text-xs text-red-600">en retard</span>}</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(i.balance, i.currency)}</td>
                  <td className="py-2 text-right"><input aria-label={`Montant réglé ${i.number}`} inputMode="decimal" value={amounts[i.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [i.id]: e.target.value })} className="w-28 rounded-md border border-slate-300 px-2 py-1 text-right text-sm" />
                    <button type="button" className="ml-2 text-xs text-brand-700 hover:underline" onClick={() => setAmounts({ ...amounts, [i.id]: i.balance })}>Solder</button></td>
                </tr>))}</tbody>
            </table>
          </div>
        ))}
        <div className="grid gap-4 sm:grid-cols-3">
          <div><label htmlFor="pay-date" className="mb-1 block text-sm font-medium text-slate-700">Date *</label><input id="pay-date" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" /></div>
          <Select label="Mode de règlement *" id="pay-method" value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(METHOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <div><label htmlFor="pay-ref" className="mb-1 block text-sm font-medium text-slate-700">Référence</label><input id="pay-ref" value={reference} maxLength={120} placeholder="N° de chèque, virement…" onChange={(e) => setReference(e.target.value)} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" /></div>
        </div>
        <PaymentExtras value={extras} onChange={setExtras} method={method} currency={open[0]?.currency ?? 'TND'} party="client" />
        <div><label htmlFor="pay-notes" className="mb-1 block text-sm font-medium text-slate-700">Note</label><input id="pay-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" /></div>
        <div className="flex items-center justify-between border-t border-slate-200 pt-3">
          <p className="text-sm">Total du règlement : <strong data-testid="pay-total">{fmtMoney(fromMil(total), open[0]?.currency ?? 'TND')}</strong></p>
          <div className="flex gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={total <= 0n && !toMil(extras.received)} onClick={submit}>Enregistrer le règlement</Button></div>
        </div>
      </div>
    </Modal>
  );
}
