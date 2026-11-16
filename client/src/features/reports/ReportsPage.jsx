import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, Download, FileSpreadsheet, FileText } from 'lucide-react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { BarChart } from '../../components/Charts.jsx';
import { Combobox, fmtDate, fmtMoney, searchClients, searchProducts, todayIso } from '../sales/shared.jsx';
import { searchSuppliers } from '../purchases/SupplierPaymentModal.jsx';

const field = 'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
const cellText = (c, v) => (c.type === 'date' ? fmtDate(v) : c.type === 'money' ? fmtMoney(v, '').trim() : c.type === 'qty' ? String(Number(v)) : v ?? '');
const FORMATS = [['csv', 'CSV', Download], ['xlsx', 'Excel', FileSpreadsheet], ['pdf', 'PDF', FileText]];

export default function ReportsPage() {
  const [params, setParams] = useSearchParams(); const key = params.get('r');
  const [catalog, setCatalog] = useState(null); const [error, setError] = useState('');
  useEffect(() => { api.get('/reports').then((r) => setCatalog(r.data)).catch((e) => setError(errorMessage(e))); }, []);
  const groups = useMemo(() => (catalog?.data ?? []).reduce((acc, r) => ({ ...acc, [r.group]: [...(acc[r.group] ?? []), r] }), {}), [catalog]);
  const current = catalog?.data.find((r) => r.key === key);
  if (error) return <Alert tone="error">{error}</Alert>; if (!catalog) return <Spinner />;
  return (
    <>
      <PageHeader title="Rapports et statistiques" subtitle="Rapports de gestion avec export CSV, Excel et PDF. Ils respectent vos permissions et ne portent que sur les données de votre entreprise." />
      <Alert tone="info">{catalog.meta.disclaimer}</Alert>
      <div className="mt-4 grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit p-3"><nav aria-label="Rapports">{Object.entries(groups).map(([g, items]) => (
          <div key={g} className="mb-3"><p className="px-2 py-1 text-xs font-semibold uppercase text-slate-500">{g}</p>
            {items.map((r) => <button key={r.key} onClick={() => setParams({ r: r.key })} className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${r.key === key ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}>{r.title}</button>)}</div>))}</nav></Card>
        {current ? <ReportView key={current.key} def={current} /> : <Card><EmptyState icon={BarChart3} title="Choisissez un rapport">Sélectionnez un rapport dans la liste pour l'afficher et l'exporter.</EmptyState></Card>}
      </div>
    </>
  );
}

function ReportView({ def }) {
  const year = todayIso().slice(0, 4);
  const [f, setF] = useState({ from: `${year}-01-01`, to: todayIso(), asOf: todayIso(), groupBy: 'month', overdueOnly: false });
  const [client, setClient] = useState(null); const [supplier, setSupplier] = useState(null); const [product, setProduct] = useState(null);
  const [state, setState] = useState({ loading: true }); const [busy, setBusy] = useState('');
  const query = useMemo(() => ({ ...(def.filters.includes('period') ? { from: f.from, to: f.to } : {}), ...(def.filters.includes('asOf') ? { asOf: f.asOf } : {}), ...(def.filters.includes('groupBy') ? { groupBy: f.groupBy } : {}),
    ...(def.filters.includes('overdue') && f.overdueOnly ? { overdueOnly: 1 } : {}), ...(client ? { clientId: client.id } : {}), ...(supplier ? { supplierId: supplier.id } : {}), ...(product ? { productId: product.id } : {}) }), [def, f, client, supplier, product]);
  const load = useCallback(async () => { setState({ loading: true }); try { const r = await api.get(`/reports/${def.key}`, { params: query }); setState({ report: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); } }, [def.key, query]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  const download = async (format) => {
    setBusy(format);
    try { const r = await api.get(`/reports/${def.key}`, { params: { ...query, format }, responseType: 'blob' }); const url = URL.createObjectURL(r.data); const a = document.createElement('a'); a.href = url; a.download = `${def.key}.${format}`; a.click(); URL.revokeObjectURL(url); }
    catch (e) { setState((s) => ({ ...s, error: 'Export impossible : ' + (e?.response?.status === 422 ? 'trop de lignes, réduisez la période' : errorMessage(e)) })); }
    setBusy('');
  };
  const rep = state.report;
  return (
    <Card>
      <div className="border-b border-slate-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold text-slate-900">{def.title}</h2>
          <div className="flex gap-2">{FORMATS.map(([k, l, Icon]) => <Button key={k} variant="secondary" loading={busy === k} disabled={!rep || !rep.rows.length} onClick={() => download(k)}><Icon size={15} aria-hidden /> {l}</Button>)}</div></div>
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          {def.filters.includes('period') && <><label className="grid gap-1 text-xs text-slate-500">Du<input aria-label="Du" type="date" className={field} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label><label className="grid gap-1 text-xs text-slate-500">Au<input aria-label="Au" type="date" className={field} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label></>}
          {def.filters.includes('asOf') && <label className="grid gap-1 text-xs text-slate-500">Situation au<input aria-label="Situation au" type="date" className={field} value={f.asOf} onChange={(e) => setF({ ...f, asOf: e.target.value })} /></label>}
          {def.filters.includes('groupBy') && <label className="grid gap-1 text-xs text-slate-500">Regrouper par<select aria-label="Regrouper par" className={field} value={f.groupBy} onChange={(e) => setF({ ...f, groupBy: e.target.value })}><option value="day">Jour</option><option value="week">Semaine</option><option value="month">Mois</option><option value="year">Année</option></select></label>}
          {def.filters.includes('overdue') && <label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={f.overdueOnly} onChange={(e) => setF({ ...f, overdueOnly: e.target.checked })} /> En retard uniquement</label>}
          {def.filters.includes('client') && <div className="w-56"><Combobox id="rp-client" label="Client" placeholder="Tous les clients" fetcher={searchClients} value={client?.name} render={(c) => ({ label: c.name, node: c.name })} onPick={setClient} />{client && <button className="text-xs text-slate-500 hover:underline" onClick={() => setClient(null)}>Tous les clients</button>}</div>}
          {def.filters.includes('supplier') && <div className="w-56"><Combobox id="rp-sup" label="Fournisseur" placeholder="Tous les fournisseurs" fetcher={searchSuppliers} value={supplier?.name} render={(c) => ({ label: c.name, node: c.name })} onPick={setSupplier} />{supplier && <button className="text-xs text-slate-500 hover:underline" onClick={() => setSupplier(null)}>Tous</button>}</div>}
          {def.filters.includes('product') && <div className="w-56"><Combobox id="rp-prod" label="Article" placeholder="Tous les articles" fetcher={searchProducts} value={product?.name} render={(c) => ({ label: c.name, node: c.name })} onPick={setProduct} />{product && <button className="text-xs text-slate-500 hover:underline" onClick={() => setProduct(null)}>Tous</button>}</div>}
        </div>
      </div>
      {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : (
        <>
          {rep.chart && rep.rows.length > 0 && rep.chart.x === 'period' && <div className="border-b border-slate-100 p-4"><BarChart data={rep.rows.map((r) => ({ label: r.period, value: r.ht }))} label={def.title} /></div>}
          {rep.rows.length === 0 ? <EmptyState icon={BarChart3} title="Aucune donnée">Aucun document ne correspond à ces critères.</EmptyState> : (
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr>{rep.columns.map((c) => <th key={c.key} className={`whitespace-nowrap px-3 py-3 ${['money', 'qty', 'number'].includes(c.type) ? 'text-right' : ''}`}>{c.label}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">{rep.rows.map((r, i) => <tr key={i} className="hover:bg-slate-50">{rep.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${['money', 'qty', 'number'].includes(c.type) ? 'text-right tabular-nums' : ''} ${String(r[c.key]).startsWith('-') && c.type === 'money' ? 'text-red-600' : ''}`}>{cellText(c, r[c.key])}</td>)}</tr>)}</tbody>
              <tfoot>{Object.keys(rep.totals ?? {}).length > 0 && <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold" data-testid="report-totals">{rep.columns.map((c, i) => <td key={c.key} className={`px-3 py-2 ${['money', 'qty', 'number'].includes(c.type) ? 'text-right tabular-nums' : ''}`}>{i === 0 ? 'TOTAL' : rep.totals[c.key] !== undefined ? cellText(c, rep.totals[c.key]) : ''}</td>)}</tr>}
                {(rep.extraTotals ?? []).map((t) => <tr key={t.label} className="bg-slate-50 font-semibold"><td className="px-3 py-2" colSpan={rep.columns.length - 1}>{t.label}</td><td className="px-3 py-2 text-right tabular-nums">{fmtMoney(t.value, '').trim()}</td></tr>)}</tfoot>
            </table></div>)}
          <div className="space-y-1 border-t border-slate-100 p-4 text-xs text-slate-500"><p>{rep.rows.length} ligne(s). {rep.note}</p><p>{state.meta.disclaimer}</p></div>
        </>
      )}
    </Card>
  );
}
