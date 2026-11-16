import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../components/ui/index.jsx';
import { api } from '../../services/api.js';

export const QUOTE_STATUS = { draft: ['Brouillon', 'neutral'], sent: ['Envoyé', 'blue'], accepted: ['Accepté', 'green'], refused: ['Refusé', 'red'], expired: ['Expiré', 'orange'], converted: ['Converti en facture', 'blue'] };
export const ORDER_STATUS = { draft: ['Brouillon', 'neutral'], confirmed: ['Confirmée', 'green'], cancelled: ['Annulée', 'red'] };
export const DELIVERY_STATUS = { none: ['Non livrée', 'neutral'], partial: ['Livrée partiellement', 'orange'], complete: ['Livrée', 'green'] };
export const INVOICING_STATUS = { none: ['Non facturée', 'neutral'], deposit: ['Acompte facturé', 'blue'], partial: ['Facturée partiellement', 'orange'], invoiced: ['Facturée', 'green'] };
export const BL_STATUS = { draft: ['Brouillon', 'neutral'], validated: ['Validé', 'green'], cancelled: ['Annulé', 'red'] };
export const INVOICE_TYPE = { deposit: "Facture d'acompte", final: 'Facture de solde' };
const INV_STATUS = { draft: ['Brouillon', 'neutral'], cancelled: ['Annulée', 'red'] };
const PAY_STATUS = { unpaid: ['Impayée', 'orange'], partial: ['Partiellement payée', 'blue'], paid: ['Payée', 'green'], credited: ['Soldée par avoir', 'green'] };

export function StatusBadge({ kind, doc }) {
  if (kind === 'quote') { const [t, tone] = QUOTE_STATUS[doc.status]; return <Badge tone={tone}>{t}</Badge>; }
  if (kind === 'sales_order') { const [t, tone] = ORDER_STATUS[doc.status]; return <Badge tone={tone}>{t}</Badge>; }
  if (kind === 'delivery_note') { const [t, tone] = BL_STATUS[doc.status]; return <Badge tone={tone}>{t}</Badge>; }
  if (doc.status === 'issued') {
    const [t, tone] = kind === 'credit_note' ? ['Émis', 'green'] : PAY_STATUS[doc.paymentStatus] ?? ['Émise', 'blue'];
    return <span className="inline-flex gap-1"><Badge tone={tone}>{t}</Badge>{doc.overdue && <Badge tone="red">En retard</Badge>}</span>;
  }
  const [t, tone] = INV_STATUS[doc.status]; return <Badge tone={tone}>{kind === 'credit_note' && doc.status === 'draft' ? 'Brouillon' : t}</Badge>;
}

export const fmtMoney = (v, cur = 'TND') => (v === null || v === undefined ? '—' : `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(v)).replace(/[  ]/g, ' ')} ${cur}`);
export const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');
export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
export const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Champ de recherche avec résultats issus de l'API (pas de liste tronquée à 100 éléments).
export function Combobox({ label, placeholder, fetcher, render, onPick, value, error, disabled, id }) {
  const [text, setText] = useState(value ?? '');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef();
  useEffect(() => { setText(value ?? ''); }, [value]);
  const search = (t) => {
    setText(t); setOpen(true); clearTimeout(timer.current);
    timer.current = setTimeout(async () => { try { setItems(await fetcher(t)); } catch { setItems([]); } }, 250);
  };
  return (
    <div className="relative">
      {label && <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">{label}</label>}
      <input id={id} role="combobox" aria-expanded={open} aria-label={label ?? placeholder} disabled={disabled} value={text} placeholder={placeholder} autoComplete="off"
        onFocus={() => { setOpen(true); search(text === value ? '' : text); }} onChange={(e) => search(e.target.value)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={`block w-full rounded-md border bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25 disabled:bg-slate-100 ${error ? 'border-red-400' : 'border-slate-300'}`} />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {open && items.length > 0 && (
        <ul role="listbox" className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-slate-200 bg-white text-sm shadow-lg">
          {items.map((it) => (
            <li key={it.id} role="option" className="cursor-pointer px-3 py-2 hover:bg-brand-50" onMouseDown={(e) => { e.preventDefault(); onPick(it); setText(render(it).label); setOpen(false); }}>{render(it).node ?? render(it).label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const searchClients = async (q) => (await api.get('/clients', { params: { q: q || undefined, status: 'active', limit: 10 } })).data.data;
export const searchProducts = async (q) => (await api.get('/products', { params: { q: q || undefined, status: 'active', limit: 10 } })).data.data;
