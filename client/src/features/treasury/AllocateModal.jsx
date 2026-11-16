import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Modal } from '../../components/ui/index.jsx';
import { fmtDate, fmtMoney } from '../sales/shared.jsx';

const toMil = (s) => { const v = String(s ?? '').trim().replace(',', '.'); if (!/^\d+(\.\d{1,3})?$/.test(v)) return null; const [i, f = ''] = v.split('.'); return BigInt(i) * 1000n + BigInt(f.padEnd(3, '0')); };
const fromMil = (n) => `${n / 1000n}.${String(n % 1000n).padStart(3, '0')}`;

// Affecte la part non affectée (avance / trop-perçu) d'un règlement à des factures ouvertes du même tiers. Contrôles définitifs côté serveur.
export default function AllocateModal({ payment, kind = 'client', onClose, onDone }) {
  const [open, setOpen] = useState([]); const [amounts, setAmounts] = useState({}); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const base = kind === 'client' ? '/payments' : '/supplier-payments';
  useEffect(() => {
    const [url, key] = kind === 'client' ? ['/invoices', 'clientId'] : ['/purchase-invoices', 'supplierId'];
    api.get(url, { params: { [key]: payment[key], open: 1, limit: 100 } }).then((r) => setOpen(r.data.data.filter((i) => i.currency === payment.currency))).catch((e) => setError(errorMessage(e)));
  }, [kind, payment]);
  const total = Object.values(amounts).reduce((s, v) => s + (toMil(v) ?? 0n), 0n); const rest = toMil(payment.unallocated) - total;
  const submit = async () => {
    setBusy(true); setError('');
    try { await api.post(`${base}/${payment.id}/allocate`, { allocations: open.filter((i) => (toMil(amounts[i.id]) ?? 0n) > 0n).map((i) => ({ invoiceId: i.id, amount: amounts[i.id] })) }); onDone(); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={`Affecter l'avance du règlement ${payment.number}`} onClose={onClose} size="lg">
      <div className="space-y-3">
        <Alert tone="error">{error}</Alert>
        <p className="text-sm text-slate-600">Montant disponible : <strong>{fmtMoney(payment.unallocated, payment.currency)}</strong></p>
        {open.length === 0 ? <p className="text-sm text-slate-500">Aucune facture ouverte dans cette devise.</p> : (
          <table className="w-full text-sm"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2">Facture</th><th className="py-2">Échéance</th><th className="py-2 text-right">Solde</th><th className="py-2 text-right">À affecter</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{open.map((i) => (
              <tr key={i.id}><td className="py-2">{i.number}</td><td className="py-2">{fmtDate(i.dueDate)}</td><td className="py-2 text-right tabular-nums">{fmtMoney(i.balance, i.currency)}</td>
                <td className="py-2 text-right"><input aria-label={`Affecter ${i.number}`} inputMode="decimal" className="w-28 rounded-md border border-slate-300 px-2 py-1 text-right text-sm" value={amounts[i.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [i.id]: e.target.value })} />
                  <button type="button" className="ml-2 text-xs text-brand-700 hover:underline" onClick={() => { const b = toMil(i.balance); const room = toMil(payment.unallocated) - (total - (toMil(amounts[i.id]) ?? 0n)); setAmounts({ ...amounts, [i.id]: fromMil(b < room ? b : room > 0n ? room : 0n) }); }}>Max</button></td></tr>))}</tbody></table>)}
        <div className="flex items-center justify-between border-t border-slate-200 pt-3"><p className="text-sm">Reste en avance : <strong>{fmtMoney(rest < 0n ? '0.000' : fromMil(rest), payment.currency)}</strong></p>
          <div className="flex gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={total <= 0n || rest < 0n} onClick={submit}>Affecter</Button></div></div>
      </div>
    </Modal>
  );
}
