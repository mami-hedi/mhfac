import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, Modal } from '../../components/ui/index.jsx';
import { BL_STATUS, DELIVERY_STATUS, INVOICING_STATUS, INVOICE_TYPE, fmtDate, fmtMoney, todayIso } from './shared.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';

// Création d'un bon de livraison : quantités par ligne, plafonnées au reste à livrer (contrôle final côté serveur).
export function DeliveryModal({ order, onClose, onDone }) {
  const [date, setDate] = useState(todayIso()); const [address, setAddress] = useState(order.client.address ?? ''); const [notes, setNotes] = useState('');
  const [qty, setQty] = useState(() => Object.fromEntries(order.lines.map((l) => [l.id, Number(l.deliverableQuantity) > 0 ? String(Number(l.deliverableQuantity)) : '0'])));
  const [warehouses, setWarehouses] = useState([]); const [wh, setWh] = useState('');
  useEffect(() => { api.get('/stock/warehouses').then((r) => { const a = r.data.data.filter((w) => w.status === 'active'); setWarehouses(a); setWh(a.find((w) => w.isDefault)?.id ?? a[0]?.id ?? ''); }).catch(() => {}); }, []);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    const lines = order.lines.filter((l) => Number(qty[l.id]) > 0).map((l) => ({ orderLineId: l.id, quantity: qty[l.id] }));
    if (!lines.length) { setError('Indiquez au moins une quantité à livrer.'); return; }
    setBusy(true); setError('');
    try { onDone((await api.post('/delivery-notes', { orderId: order.id, warehouseId: wh || undefined, deliveryDate: date, deliveryAddress: address || null, notes: notes || null, lines })).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={`Bon de livraison — ${order.number}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor="bl-date" className="mb-1 block text-sm font-medium">Date de livraison</label><input id="bl-date" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} className={field} /></div>
          <div><label htmlFor="bl-wh" className="mb-1 block text-sm font-medium">Sortie de stock depuis</label><select id="bl-wh" value={wh} onChange={(e) => setWh(e.target.value)} className={field}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
          <div><label htmlFor="bl-addr" className="mb-1 block text-sm font-medium">Adresse de livraison</label><input id="bl-addr" value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} className={field} /></div>
        </div>
        <table className="w-full text-sm"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2">Désignation</th><th className="py-2 text-right">Commandé</th><th className="py-2 text-right">Reste à livrer</th><th className="py-2 text-right">À livrer</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{order.lines.map((l) => (
            <tr key={l.id}><td className="py-2">{l.description}</td><td className="py-2 text-right tabular-nums">{Number(l.quantity)}</td><td className="py-2 text-right tabular-nums">{Number(l.deliverableQuantity)}</td>
              <td className="py-2 text-right"><input aria-label={`Quantité à livrer ligne ${l.position}`} disabled={Number(l.deliverableQuantity) <= 0} value={qty[l.id]} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} inputMode="decimal" className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right tabular-nums" /></td></tr>
          ))}</tbody></table>
        <div><label htmlFor="bl-notes" className="mb-1 block text-sm font-medium">Notes</label><textarea id="bl-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={field} /></div>
        <p className="text-xs text-slate-500">Le bon est créé en brouillon ; à sa validation il reçoit son numéro et les articles suivis en stock sortent de l'entrepôt choisi (refusé si le stock est insuffisant).</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={submit}>Créer le bon (brouillon)</Button></div>
      </div>
    </Modal>
  );
}

export function DepositModal({ order, onClose, onDone }) {
  const used = (order.invoices ?? []).filter((i) => i.type === 'deposit' && i.status !== 'cancelled').reduce((a, i) => a + Number(i.depositPct), 0);
  const [pct, setPct] = useState('30'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); setError(''); try { onDone((await api.post(`/orders/${order.id}/deposit`, { pct })).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); } };
  return (
    <Modal title={`Facture d'acompte — ${order.number}`} onClose={onClose}>
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <div><label htmlFor="dep-pct" className="mb-1 block text-sm font-medium">Pourcentage de la commande (%)</label><input id="dep-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} className={field} /></div>
        <p className="text-sm text-slate-600">Déjà facturé en acompte : {used} %. La facture est créée en brouillon, une ligne par taux de TVA ; elle sera déduite (TTC) de la facture de solde.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={submit}>Créer l'acompte (brouillon)</Button></div>
      </div>
    </Modal>
  );
}

// Livraison et facturation : statuts dérivés + documents liés.
export function OrderPanels({ order }) {
  const cur = order.currency;
  return (
    <>
      {order.status === 'confirmed' && (
        <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">Avancement</h2>
          <div className="flex flex-wrap gap-2" data-testid="order-progress"><Badge tone={DELIVERY_STATUS[order.deliveryStatus][1]}>{DELIVERY_STATUS[order.deliveryStatus][0]}</Badge><Badge tone={INVOICING_STATUS[order.invoicingStatus][1]}>{INVOICING_STATUS[order.invoicingStatus][0]}</Badge></div>
        </Card>
      )}
      {order.deliveryNotes.length > 0 && (
        <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">Bons de livraison</h2>
          <ul className="space-y-1 text-sm" data-testid="order-bls">{order.deliveryNotes.map((n) => <li key={n.id}><Link className="text-brand-700 hover:underline" to={`/sales/delivery-notes/${n.id}`}>{n.number ?? 'Brouillon'}</Link> · {fmtDate(n.date)} · {BL_STATUS[n.status][0]}</li>)}</ul></Card>
      )}
      {order.invoices.length > 0 && (
        <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">Factures liées</h2>
          <ul className="space-y-1 text-sm" data-testid="order-invoices">{order.invoices.map((i) => <li key={i.id}><Link className="text-brand-700 hover:underline" to={`/sales/invoices/${i.id}`}>{i.number ?? 'Brouillon'}</Link> · {INVOICE_TYPE[i.type] ?? 'Facture'}{i.type === 'deposit' ? ` ${Number(i.depositPct)} %` : ''} · {fmtMoney(i.netPayable, cur)}{i.status === 'cancelled' ? ' · annulée' : ''}</li>)}</ul></Card>
      )}
    </>
  );
}
