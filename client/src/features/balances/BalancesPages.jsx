import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { ExportButton, Pagination } from '../masterdata/shared.jsx';
import ListFilters, { PAGE_SIZE, useDebouncedJson, useListFilters } from '../../components/ListFilters.jsx';
import { fmtDate, fmtMoney } from '../sales/shared.jsx';

// Une seule paire de pages pour les deux sens : fournisseurs (ce que nous devons) et clients (ce qu'on nous doit).
const SIDES = {
  supplier: { api: '/supplier-balances', base: '/purchases/balances', invoicePath: '/purchases/invoices', payPath: '/purchases/payments', title: 'Soldes fournisseurs', noun: 'Fournisseur', owe: 'Total dû',
    subtitle: "Ce que vous devez à chaque fournisseur, calculé en temps réel : factures d'achat enregistrées (retenue à la source déduite) moins avoirs et règlements. Une ligne par devise.",
    csv: 'soldes-fournisseurs.csv', advanceHint: 'Règlements versés non affectés à une facture (à imputer).' },
  client: { api: '/client-balances', base: '/sales/balances', invoicePath: '/sales/invoices', payPath: '/payments', title: 'Créances clients', noun: 'Client', owe: 'Total à encaisser',
    subtitle: 'Ce que chaque client vous doit, calculé en temps réel : factures émises moins avoirs et encaissements. Une ligne par devise.',
    csv: 'creances-clients.csv', advanceHint: 'Encaissements reçus non affectés à une facture (à imputer).' },
};
const AGING = [['d1_30', '1–30 j'], ['d31_60', '31–60 j'], ['d61_90', '61–90 j'], ['over90', '+ 90 j']];
const TYPE = { invoice: 'Facture', credit_note: 'Avoir', payment: 'Règlement' };
const num = 'whitespace-nowrap px-4 py-3 text-right tabular-nums';

export function BalancesPage({ side }) {
  const S = SIDES[side];
  const fields = [
    { key: 'q', label: S.noun, type: 'search', placeholder: 'Nom…' },
    { key: 'currency', label: 'Devise', type: 'select', options: [['', 'Toutes'], ['TND', 'TND'], ['EUR', 'EUR'], ['USD', 'USD']] },
    { key: 'overdueOnly', label: 'Échéances', type: 'select', options: [['', 'Toutes'], ['true', 'Avec échu uniquement']] },
    { key: 'minAmount', label: 'Montant dû min.', type: 'money' },
  ];
  const filters = useListFilters(fields.map((x) => x.key)); const { page, params } = filters;
  const debounced = useDebouncedJson(params);
  const [state, setState] = useState({ loading: true }); const [exportError, setExportError] = useState('');
  const load = useCallback(async () => {
    try { const r = await api.get(S.api, { params: { ...JSON.parse(debounced), page, limit: PAGE_SIZE } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); }
  }, [debounced, page, S.api]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHeader title={S.title} subtitle={S.subtitle} />
      {state.meta?.totals?.length > 0 && <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="balance-totals">
        {state.meta.totals.map((t) => (
          <Card key={t.currency} className="p-4 text-sm">
            <p className="text-xs uppercase text-slate-500">{S.owe} · {t.currency} · {t.parties} {S.noun.toLowerCase()}{t.parties > 1 ? 's' : ''}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{fmtMoney(t.total, t.currency)}</p>
            <p className="mt-1 text-slate-600">dont échu : <strong className={Number(t.overdue) > 0 ? 'text-red-700' : ''}>{fmtMoney(t.overdue, t.currency)}</strong></p>
            {Number(t.advances) > 0 && <p className="text-slate-600">avances non affectées : {fmtMoney(t.advances, t.currency)} → solde net <strong>{fmtMoney(t.net, t.currency)}</strong></p>}
          </Card>))}
      </div>}
      <Card>
        <ListFilters fields={fields} filters={filters} exportPath={`${S.api}/export`} exportName={S.csv} onError={setExportError} />
        {exportError && <div className="px-4 pt-3"><Alert tone="error" onClose={() => setExportError('')}>{exportError}</Alert></div>}
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={Scale} title={filters.active ? 'Aucun résultat' : 'Aucun solde ouvert'}>Les soldes apparaissent dès qu'une facture {side === 'supplier' ? "d'achat est enregistrée" : 'est émise'} et n'est pas entièrement réglée.</EmptyState>
        ) : (<>
          <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="px-4 py-3">{S.noun}</th><th className="px-4 py-3 text-right">Factures</th><th className="px-4 py-3 text-right">{S.owe}</th><th className="px-4 py-3 text-right">Non échu</th>
              {AGING.map(([, l]) => <th key={l} className="px-4 py-3 text-right">{l}</th>)}<th className="px-4 py-3 text-right" title={S.advanceHint}>Avances</th><th className="px-4 py-3 text-right">Solde net</th><th className="px-4 py-3">Dernier règlement</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((r) => (
              <tr key={`${r.id}-${r.currency}`} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium"><Link className="text-brand-700 hover:underline" to={`${S.base}/${r.id}?currency=${r.currency}`}>{r.name}</Link></td>
                <td className={num}>{r.openInvoices}</td><td className={`${num} font-semibold`}>{fmtMoney(r.total, r.currency)}</td><td className={num}>{fmtMoney(r.notDue, '')}</td>
                {AGING.map(([k]) => <td key={k} className={`${num} ${Number(r.aging[k]) > 0 ? (k === 'over90' ? 'font-medium text-red-700' : 'text-orange-600') : 'text-slate-400'}`}>{fmtMoney(r.aging[k], '')}</td>)}
                <td className={num}>{Number(r.advances) > 0 ? fmtMoney(r.advances, '') : '—'}</td><td className={`${num} font-semibold`}>{fmtMoney(r.net, r.currency)}</td>
                <td className="px-4 py-3 text-slate-600">{r.lastPayment ? fmtDate(r.lastPayment) : '—'}</td>
              </tr>))}</tbody></table></div>
          <Pagination meta={state.meta} onPage={(p) => filters.set({ page: p })} />
        </>)}
      </Card>
    </>
  );
}

export function BalanceDetailPage({ side }) {
  const S = SIDES[side]; const { id } = useParams(); const [sp, setSp] = useSearchParams();
  const [state, setState] = useState({ loading: true }); const [st, setSt] = useState(null); const [err, setErr] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const currency = sp.get('currency') || state.data?.summary?.[0]?.currency || 'TND';
  const loadMain = useCallback(async () => {
    try { const r = await api.get(`${S.api}/${id}`); setState({ data: r.data.data, asOf: r.data.meta.asOf }); } catch (e) { setState({ error: errorMessage(e) }); }
  }, [id, S.api]);
  useEffect(() => { loadMain(); }, [loadMain]);
  const loadStmt = useCallback(async () => {
    if (!state.data) return;
    try { const r = await api.get(`${S.api}/${id}/statement`, { params: { currency, from: range.from || undefined, to: range.to || undefined } }); setSt(r.data.data); setErr(''); } catch (e) { setErr(errorMessage(e)); }
  }, [state.data, id, S.api, currency, range]);
  useEffect(() => { loadStmt(); }, [loadStmt]);
  if (state.loading) return <Spinner />;
  if (state.error) return <Alert tone="error">{state.error}</Alert>;
  const d = state.data; const sum = d.summary.find((x) => x.currency === currency); const invoices = d.invoices.filter((i) => i.currency === currency); const advances = d.unallocatedPayments.filter((p) => p.currency === currency);
  return (
    <>
      <PageHeader title={d.party.name} subtitle={`${S.title} — situation au ${fmtDate(state.asOf)}`} actions={<Link to={S.payPath}><Button variant="secondary">{side === 'supplier' ? 'Enregistrer un règlement' : 'Enregistrer un encaissement'}</Button></Link>} />
      {d.summary.length > 1 && <div className="mb-3 flex gap-2">{d.summary.map((x) => <Button key={x.currency} variant={x.currency === currency ? 'primary' : 'secondary'} onClick={() => setSp({ currency: x.currency })}>{x.currency}</Button>)}</div>}
      {!sum ? <Card className="mb-4 p-4 text-sm text-slate-600">Aucun solde ouvert pour ce {S.noun.toLowerCase()}.</Card> : (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">{S.owe}</p><p className="mt-1 text-xl font-semibold tabular-nums">{fmtMoney(sum.total, currency)}</p></Card>
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Dont échu</p><p className={`mt-1 text-xl font-semibold tabular-nums ${Number(sum.overdue) > 0 ? 'text-red-700' : ''}`}>{fmtMoney(sum.overdue, currency)}</p></Card>
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Avances non affectées</p><p className="mt-1 text-xl font-semibold tabular-nums">{fmtMoney(sum.advances, currency)}</p></Card>
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Solde net</p><p className="mt-1 text-xl font-semibold tabular-nums">{fmtMoney(sum.net, currency)}</p></Card>
        </div>)}
      <Card className="mb-4"><h2 className="border-b border-slate-200 p-4 text-base font-semibold">Factures ouvertes</h2>
        {invoices.length === 0 ? <p className="p-4 text-sm text-slate-500">Aucune facture ouverte.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Facture</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Échéance</th><th className="px-4 py-3 text-right">Net à payer</th><th className="px-4 py-3 text-right">Réglé</th><th className="px-4 py-3 text-right">Avoirs</th><th className="px-4 py-3 text-right">Reste</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{invoices.map((i) => (
              <tr key={i.id}><td className="px-4 py-3"><Link className="font-mono text-xs text-brand-700 hover:underline" to={`${S.invoicePath}/${i.id}`}>{i.number}</Link>{i.supplierRef && <span className="ml-2 text-xs text-slate-500">{i.supplierRef}</span>}</td>
                <td className="px-4 py-3">{fmtDate(i.issueDate)}</td><td className="px-4 py-3">{fmtDate(i.dueDate)} {i.overdue && <Badge tone="red">échue +{i.daysOverdue} j</Badge>}</td>
                <td className={num}>{fmtMoney(i.netPayable, '')}</td><td className={num}>{fmtMoney(i.paid, '')}</td><td className={num}>{Number(i.credited) > 0 ? fmtMoney(i.credited, '') : '—'}</td><td className={`${num} font-semibold`}>{fmtMoney(i.balance, currency)}</td></tr>))}</tbody></table></div>)}
        {advances.length > 0 && <div className="border-t border-slate-200 p-4 text-sm"><p className="font-medium">Règlements non affectés</p><ul className="mt-1 list-disc pl-5 text-slate-600">{advances.map((p) => <li key={p.id}>{p.number} · {fmtDate(p.date)} · {fmtMoney(p.amount, currency)}</li>)}</ul></div>}
      </Card>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 p-4">
          <h2 className="text-base font-semibold">Relevé de compte · {currency}</h2>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-600">Du<input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="mt-1 block rounded-md border border-slate-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-slate-600">Au<input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="mt-1 block rounded-md border border-slate-300 px-3 py-2 text-sm" /></label>
            <ExportButton path={`${S.api}/${id}/statement/export`} params={{ currency, from: range.from || undefined, to: range.to || undefined }} filename={`releve-${d.party.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30)}.csv`} onError={setErr} />
          </div>
        </div>
        {err && <div className="p-4"><Alert tone="error">{err}</Alert></div>}
        {!st ? <Spinner /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm" data-testid="statement">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Pièce</th><th className="px-4 py-3 text-right">{side === 'supplier' ? 'Nous devons +' : 'Il nous doit +'}</th><th className="px-4 py-3 text-right">Diminue</th><th className="px-4 py-3 text-right">Solde</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              <tr className="bg-slate-50/60 text-slate-600"><td className="px-4 py-2" colSpan={5}>Solde initial</td><td className={`${num} py-2`}>{fmtMoney(st.opening, '')}</td></tr>
              {st.lines.map((l) => (<tr key={`${l.type}-${l.id}`}><td className="px-4 py-3">{fmtDate(l.date)}</td><td className="px-4 py-3">{TYPE[l.type]}</td><td className="px-4 py-3 font-mono text-xs">{l.ref}</td>
                <td className={num}>{Number(l.charge) > 0 ? fmtMoney(l.charge, '') : ''}</td><td className={num}>{Number(l.settlement) > 0 ? fmtMoney(l.settlement, '') : ''}</td><td className={`${num} font-medium`}>{fmtMoney(l.balance, '')}</td></tr>))}
              <tr className="border-t-2 border-slate-200 font-semibold"><td className="px-4 py-3" colSpan={5}>Solde final</td><td className={num}>{fmtMoney(st.closing, currency)}</td></tr>
            </tbody></table></div>)}
        <p className="border-t border-slate-200 p-4 text-xs text-slate-500">Le solde final du relevé inclut les règlements non affectés : il correspond au « Solde net » ci-dessus.</p>
      </Card>
    </>
  );
}
