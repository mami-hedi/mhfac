import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Archive, Ban, Boxes, CheckCircle2, History, Pencil, Plus, Printer, Search, SlidersHorizontal, Trash2, Warehouse as WarehouseIcon } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { Pagination, downloadCsv, useDebounced } from '../masterdata/shared.jsx';
import ListFilters, { PAGE_SIZE, useDebouncedJson, useListFilters } from '../../components/ListFilters.jsx';
import { Combobox, fmtDate, fmtMoney, todayIso } from '../sales/shared.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const num = (v) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4 }).format(Number(v)));
const STATUS = { draft: ['Brouillon', 'neutral'], validated: ['Validé', 'green'], cancelled: ['Annulé', 'red'] };
const KIND = { entry: 'Entrée', withdrawal: 'Prélèvement', transfer_in: 'Transfert (entrée)', transfer_out: 'Transfert (sortie)', adjustment: 'Ajustement', inventory: 'Inventaire', delivery: 'Livraison', delivery_reversal: 'Annulation de livraison', cancellation: 'Annulation de bon' };
const searchTracked = async (q) => (await api.get('/products', { params: { q: q || undefined, status: 'active', limit: 50 } })).data.data.filter((p) => p.trackStock && p.type === 'product').slice(0, 10);
export const useWarehouses = () => {
  const [list, setList] = useState([]);
  useEffect(() => { api.get('/stock/warehouses').then((r) => setList(r.data.data)).catch(() => {}); }, []);
  return list;
};
const WhSelect = ({ id, label, value, onChange, list, disabled }) => (
  <div><label htmlFor={id} className="mb-1 block text-sm font-medium">{label}</label>
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={field}>{list.filter((w) => w.status === 'active').map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
);

// ---------------- Inventaire (niveaux et valorisation)
function AdjustModal({ row, warehouses, onClose, onDone }) {
  const [wh, setWh] = useState(warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? '');
  const [mode, setMode] = useState('set'); const [dir, setDir] = useState('in'); const [qty, setQty] = useState(''); const [reason, setReason] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError('');
    try { await api.post('/stock/adjustments', { productId: row.productId, warehouseId: wh, mode, direction: mode === 'delta' ? dir : undefined, quantity: qty, reason }); onDone(); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={`Ajuster le stock — ${row.name}`} onClose={onClose}>
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <WhSelect id="adj-wh" label="Entrepôt" value={wh} onChange={setWh} list={warehouses} />
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="adj-mode" checked={mode === 'set'} onChange={() => setMode('set')} /> Fixer la quantité</label>
          <label className="flex items-center gap-2"><input type="radio" name="adj-mode" checked={mode === 'delta'} onChange={() => setMode('delta')} /> Appliquer un écart</label>
        </div>
        {mode === 'delta' && <select aria-label="Sens" value={dir} onChange={(e) => setDir(e.target.value)} className={field}><option value="in">Entrée (+)</option><option value="out">Sortie (−)</option></select>}
        <div><label htmlFor="adj-qty" className="mb-1 block text-sm font-medium">{mode === 'set' ? 'Nouvelle quantité en stock' : 'Quantité'}</label><input id="adj-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} className={field} /></div>
        <div><label htmlFor="adj-reason" className="mb-1 block text-sm font-medium">Motif *</label><input id="adj-reason" value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} className={field} placeholder="Ex. casse, erreur de comptage, don…" /></div>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={!qty || reason.trim().length < 3} onClick={submit}>Enregistrer l'ajustement</Button></div>
      </div>
    </Modal>
  );
}

export function InventoryPage() {
  const { can } = useAuth(); const warehouses = useWarehouses();
  const fields = [
    { key: 'warehouseId', label: 'Entrepôt', type: 'select', options: [['', 'Tous les entrepôts'], ...warehouses.map((w) => [w.id, w.name])] },
    { key: 'below', label: 'Niveau', type: 'select', options: [['', 'Tous'], ['1', 'Sous le seuil d\'alerte']] },
    { key: 'q', label: 'Recherche', type: 'search', placeholder: 'Nom, SKU ou code-barres…' },
  ];
  const filters = useListFilters(fields.map((x) => x.key)); const { page, params } = filters;
  const [state, setState] = useState({ loading: true }); const [adj, setAdj] = useState(null); const [notice, setNotice] = useState('');
  const debounced = useDebouncedJson(params);
  const load = useCallback(async () => {
    try { const r = await api.get('/stock/levels', { params: { ...JSON.parse(debounced), page, limit: PAGE_SIZE } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); }
  }, [debounced, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHeader title="Inventaire" subtitle="Quantités par article et par entrepôt, valorisées au coût moyen pondéré. Seuls les articles dont le suivi de stock est activé apparaissent." />
      <div className="mb-4"><Alert tone="success" onClose={() => setNotice('')}>{notice}</Alert></div>
      <Card>
        <ListFilters fields={fields} filters={filters} exportPath="/stock/levels/export" exportName="niveaux-stock.csv" onError={(t) => setState((st) => ({ ...st, exportError: t }))} />
        {state.exportError && <div className="px-4 pt-3"><Alert tone="error" onClose={() => setState((st) => ({ ...st, exportError: '' }))}>{state.exportError}</Alert></div>}
        {state.meta && <p className="border-b border-slate-200 px-4 py-2 text-right text-sm text-slate-600" data-testid="stock-value">Valeur du stock : <strong>{fmtMoney(state.meta.totalValue)}</strong></p>}
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={Boxes} title={filters.active ? 'Aucun résultat' : 'Aucun article suivi en stock'}>Activez « Suivre le stock » sur un article (menu Articles), puis enregistrez une entrée de stock.</EmptyState>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Article</th><th className="px-4 py-3 text-right">Quantité</th><th className="px-4 py-3">Répartition</th><th className="px-4 py-3 text-right">Coût moyen</th><th className="px-4 py-3 text-right">Valeur</th><th className="px-4 py-3">Seuil</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((r) => (
              <tr key={r.productId} className="hover:bg-slate-50">
                <td className="px-4 py-3"><p className="font-medium text-slate-900">{r.name}</p><p className="font-mono text-xs text-slate-500">{r.sku}</p></td>
                <td className="px-4 py-3 text-right tabular-nums font-medium">{num(r.quantity)} <span className="text-xs text-slate-500">{r.unit}</span></td>
                <td className="px-4 py-3 text-xs text-slate-600">{r.warehouses.length ? r.warehouses.map((w) => `${w.name} : ${num(w.quantity)}`).join(' · ') : '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(r.avgCost, '')}</td><td className="px-4 py-3 text-right tabular-nums">{fmtMoney(r.value, '')}</td>
                <td className="px-4 py-3">{r.threshold !== null ? <span className="inline-flex items-center gap-1">{num(r.threshold)} {r.belowThreshold && <Badge tone="red"><AlertTriangle size={12} className="mr-1 inline" aria-hidden />Alerte</Badge>}</span> : '—'}</td>
                <td className="px-4 py-3 text-right">{can('stock.validate') && <Button variant="ghost" aria-label={`Ajuster ${r.name}`} onClick={() => setAdj(r)}><SlidersHorizontal size={15} /> Ajuster</Button>}</td>
              </tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(p) => filters.set({ page: p })} />
      </Card>
      {adj && <AdjustModal row={adj} warehouses={warehouses.filter((w) => w.status === 'active')} onClose={() => setAdj(null)} onDone={() => { setAdj(null); setNotice('Ajustement enregistré'); load(); }} />}
    </>
  );
}

// ---------------- Mouvements
export function MovementsPage() {
  const warehouses = useWarehouses();
  const fields = [
    { key: 'productId', label: 'Article', type: 'entity', path: '/products', placeholder: 'Sélectionner un article' },
    { key: 'from', label: 'Date de début', type: 'date' }, { key: 'to', label: 'Date de fin', type: 'date' },
    { key: 'warehouseId', label: 'Entrepôt', type: 'select', options: [['', 'Tous les entrepôts'], ...warehouses.map((w) => [w.id, w.name])] },
    { key: 'kind', label: 'Nature', type: 'select', options: [['', 'Toutes natures'], ...Object.entries(KIND)], advanced: true },
    { key: 'q', label: 'Recherche avancée', type: 'search', placeholder: 'Article, SKU, n° de document ou motif…', advanced: true },
  ];
  const filters = useListFilters(fields.map((x) => x.key)); const { page, params } = filters;
  const [state, setState] = useState({ loading: true });
  const debounced = useDebouncedJson(params);
  useEffect(() => {
    api.get('/stock/movements', { params: { ...JSON.parse(debounced), page, limit: PAGE_SIZE } })
      .then((r) => setState({ rows: r.data.data, meta: r.data.meta })).catch((e) => setState({ error: errorMessage(e) }));
  }, [debounced, page]);
  const SOURCE_LINK = { delivery_note: '/sales/delivery-notes', stock_entry: '/stock/entries', stock_withdrawal: '/stock/withdrawals', stock_transfer: '/stock/transfers', stock_count: '/stock/sheets' };
  return (
    <>
      <PageHeader title="Mouvements de stock" subtitle="Journal complet et non modifiable : une erreur se corrige par un mouvement inverse, jamais par une suppression." />
      <Card>
        <ListFilters fields={fields} filters={filters} exportPath="/stock/movements/export" exportName="mouvements-stock.csv" onError={(t) => setState((st) => ({ ...st, exportError: t }))} />
        {state.exportError && <div className="px-4 pt-3"><Alert tone="error" onClose={() => setState((st) => ({ ...st, exportError: '' }))}>{state.exportError}</Alert></div>}
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={History} title="Aucun mouvement">Les mouvements apparaissent dès la première entrée de stock.</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Article</th><th className="px-4 py-3">Entrepôt</th><th className="px-4 py-3">Nature</th><th className="px-4 py-3 text-right">Quantité</th><th className="px-4 py-3 text-right">Coût unit.</th><th className="px-4 py-3 text-right">Solde</th><th className="px-4 py-3">Document</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((m) => (
              <tr key={m.id}><td className="px-4 py-3">{fmtDate(m.date)}</td><td className="px-4 py-3"><p className="font-medium">{m.productName}</p><p className="font-mono text-xs text-slate-500">{m.sku}</p></td><td className="px-4 py-3">{m.warehouseName}</td><td className="px-4 py-3">{KIND[m.kind]}</td>
                <td className={`px-4 py-3 text-right tabular-nums font-medium ${Number(m.quantity) < 0 ? 'text-red-700' : 'text-green-700'}`}>{Number(m.quantity) > 0 ? '+' : ''}{num(m.quantity)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(m.unitCost, '')}</td><td className="px-4 py-3 text-right tabular-nums">{num(m.balanceAfter)}</td>
                <td className="px-4 py-3 font-mono text-xs">{m.sourceNumber && SOURCE_LINK[m.sourceType] && m.sourceId ? <Link className="text-brand-700 hover:underline" to={`${SOURCE_LINK[m.sourceType]}/${m.sourceId}`}>{m.sourceNumber}</Link> : (m.sourceNumber ?? '—')}{m.reason && <p className="font-sans text-xs text-slate-500">{m.reason}</p>}</td></tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(p) => filters.set({ page: p })} />
      </Card>
    </>
  );
}

// ---------------- Bons (entrée, prélèvement, transfert)
const V = {
  entry: { api: '/stock/entries', base: '/stock/entries', title: "Bons d'entrée", one: "bon d'entrée", newLabel: "Nouveau bon d'entrée", subtitle: "Réception de marchandises en stock (achat hors module Achats, production, stock initial). Valorisée au coût saisi.", cost: true },
  withdrawal: { api: '/stock/withdrawals', base: '/stock/withdrawals', title: 'Bons de prélèvement', one: 'bon de prélèvement', newLabel: 'Nouveau bon de prélèvement', subtitle: 'Sorties de stock hors vente : usage interne, casse, échantillons. Motif obligatoire ; valorisées au coût moyen.' },
  transfer: { api: '/stock/transfers', base: '/stock/transfers', title: 'Bons de transfert', one: 'bon de transfert', newLabel: 'Nouveau bon de transfert', subtitle: "Déplacement de stock d'un entrepôt à un autre : la quantité totale et le coût moyen ne changent pas." },
};

function VoucherForm({ type, initial, warehouses, onClose, onDone }) {
  const cfg = V[type]; const active = warehouses.filter((w) => w.status === 'active');
  const [f, setF] = useState({
    warehouseId: initial?.warehouse.id ?? active.find((w) => w.isDefault)?.id ?? active[0]?.id ?? '', toWarehouseId: initial?.toWarehouse?.id ?? active.find((w) => w.id !== (active.find((x) => x.isDefault)?.id))?.id ?? '',
    date: initial?.date ?? todayIso(), reason: initial?.reason ?? '', notes: initial?.notes ?? '',
    lines: initial?.lines.map((l) => ({ productId: l.productId, name: l.name, quantity: String(Number(l.quantity)), unitCost: l.unitCost ? String(Number(l.unitCost)) : '' })) ?? [{ productId: '', name: '', quantity: '1', unitCost: '' }],
  });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const setLine = (i, patch) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const submit = async () => {
    setBusy(true); setError('');
    const body = { warehouseId: f.warehouseId, toWarehouseId: type === 'transfer' ? f.toWarehouseId : undefined, date: f.date, reason: f.reason || null, notes: f.notes || null,
      lines: f.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: type === 'entry' && l.unitCost ? l.unitCost : undefined })) };
    try { onDone((initial ? await api.put(`${cfg.api}/${initial.id}`, body) : await api.post(cfg.api, body)).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={initial ? `Modifier le ${cfg.one}` : cfg.newLabel} onClose={onClose} size="lg">
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <WhSelect id="v-wh" label={type === 'transfer' ? 'Entrepôt d\'origine' : 'Entrepôt'} value={f.warehouseId} onChange={(v) => setF({ ...f, warehouseId: v })} list={active} />
          {type === 'transfer' && <WhSelect id="v-to" label="Entrepôt de destination" value={f.toWarehouseId} onChange={(v) => setF({ ...f, toWarehouseId: v })} list={active} />}
          <div><label htmlFor="v-date" className="mb-1 block text-sm font-medium">Date</label><input id="v-date" type="date" max={todayIso()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className={field} /></div>
          {type !== 'transfer' && <div><label htmlFor="v-reason" className="mb-1 block text-sm font-medium">Motif{type === 'withdrawal' ? ' *' : ''}</label><input id="v-reason" value={f.reason} maxLength={255} onChange={(e) => setF({ ...f, reason: e.target.value })} className={field} placeholder={type === 'withdrawal' ? 'Ex. usage interne, casse' : 'Ex. stock initial'} /></div>}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Articles</h3><Button type="button" variant="secondary" onClick={() => setF({ ...f, lines: [...f.lines, { productId: '', name: '', quantity: '1', unitCost: '' }] })}><Plus size={14} aria-hidden /> Ligne</Button></div>
          {f.lines.map((l, i) => (
            <div key={i} className="grid items-end gap-2 rounded-md border border-slate-200 p-2 sm:grid-cols-12" data-testid="v-line">
              <div className="sm:col-span-6"><Combobox label={i === 0 ? 'Article suivi en stock' : undefined} placeholder="Rechercher un article…" value={l.name} fetcher={searchTracked} render={(p) => ({ label: p.name, node: <span><strong>{p.name}</strong> <span className="text-xs text-slate-500">{p.sku}</span></span> })} onPick={(p) => setLine(i, { productId: p.id, name: p.name, unitCost: type === 'entry' && !l.unitCost ? (p.purchasePrice ?? '') : l.unitCost })} /></div>
              <input aria-label={`Quantité ligne ${i + 1}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className={`${field} sm:col-span-2`} />
              {cfg.cost ? <input aria-label={`Coût unitaire ligne ${i + 1}`} placeholder="Coût unitaire HT" inputMode="decimal" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} className={`${field} sm:col-span-3`} /> : <span className="sm:col-span-3" />}
              {f.lines.length > 1 && <Button type="button" variant="ghost" aria-label={`Supprimer la ligne ${i + 1}`} onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })}><Trash2 size={14} className="text-red-600" /></Button>}
            </div>))}
        </div>
        <div><label htmlFor="v-notes" className="mb-1 block text-sm font-medium">Notes</label><textarea id="v-notes" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className={field} /></div>
        <p className="text-xs text-slate-500">Le bon est créé en brouillon : le stock ne bouge qu'à la validation, et une seule fois.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={f.lines.some((l) => !l.productId)} onClick={submit}>{initial ? 'Enregistrer' : 'Créer le brouillon'}</Button></div>
      </div>
    </Modal>
  );
}

export function VoucherListPage({ type }) {
  const cfg = V[type]; const { can } = useAuth(); const navigate = useNavigate(); const warehouses = useWarehouses();
  const fields = [
    { key: 'from', label: 'Date de début', type: 'date' }, { key: 'to', label: 'Date de fin', type: 'date' },
    { key: 'status', label: 'Statut', type: 'select', options: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['validated', 'Validés'], ['cancelled', 'Annulés']] },
    { key: 'q', label: 'Recherche avancée', type: 'search', advanced: true, placeholder: 'Numéro, motif, notes…' },
    { key: 'productId', label: 'Article', type: 'entity', path: '/products', placeholder: 'Sélectionner un article', advanced: true, perm: 'product.read' },
  ];
  const filters = useListFilters(fields.map((x) => x.key)); const { page, params } = filters;
  const [state, setState] = useState({ loading: true }); const [form, setForm] = useState(false); const debounced = useDebouncedJson(params);
  useEffect(() => {
    api.get(cfg.api, { params: { ...JSON.parse(debounced), page, limit: PAGE_SIZE } }).then((r) => setState({ rows: r.data.data, meta: r.data.meta })).catch((e) => setState({ error: errorMessage(e) }));
  }, [cfg.api, debounced, page]);
  return (
    <>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle} actions={can('stock.write') && <Button onClick={() => setForm(true)}><Plus size={16} aria-hidden /> {cfg.newLabel}</Button>} />
      <Card>
        <ListFilters fields={fields} filters={filters} exportPath={`${cfg.api}/export`} exportName={`${cfg.api.slice(1)}.csv`} onError={(t) => setState((st) => ({ ...st, exportError: t }))} />
        {state.exportError && <div className="px-4 pt-3"><Alert tone="error" onClose={() => setState((st) => ({ ...st, exportError: '' }))}>{state.exportError}</Alert></div>}
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={Boxes} title={`Aucun ${cfg.one}`}>{cfg.subtitle}</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Numéro</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">{type === 'transfer' ? 'Origine → destination' : 'Entrepôt'}</th><th className="px-4 py-3">Lignes</th><th className="px-4 py-3">Statut</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50"><td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`${cfg.base}/${r.id}`}>{r.number ?? 'Brouillon'}</Link></td><td className="px-4 py-3">{fmtDate(r.date)}</td>
                <td className="px-4 py-3">{r.warehouse}{r.toWarehouse ? ` → ${r.toWarehouse}` : ''}</td><td className="px-4 py-3">{r.lineCount}</td><td className="px-4 py-3"><Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge></td></tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(p) => filters.set({ page: p })} />
      </Card>
      {form && <VoucherForm type={type} warehouses={warehouses} onClose={() => setForm(false)} onDone={(v) => navigate(`${cfg.base}/${v.id}`)} />}
    </>
  );
}

export function VoucherViewPage({ type }) {
  const cfg = V[type]; const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth(); const warehouses = useWarehouses();
  const [doc, setDoc] = useState(null); const [error, setError] = useState(''); const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [busy, setBusy] = useState(''); const [modal, setModal] = useState(null); const [reason, setReason] = useState(''); const [hist, setHist] = useState(null);
  const load = useCallback(async () => { try { setDoc((await api.get(`${cfg.api}/${id}`)).data.data); setHist(null); } catch (e) { setError(errorMessage(e)); } }, [cfg.api, id]);
  useEffect(() => { load(); }, [load]);
  const run = async (key, fn, ok) => { setBusy(key); setNotice({ tone: 'success', text: '' }); try { await fn(); if (ok) setNotice({ tone: 'success', text: ok }); await load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(''); } };
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!doc) return <Spinner />;
  const draft = doc.status === 'draft';
  return (
    <>
      <PageHeader title={doc.number ?? `${cfg.one[0].toUpperCase()}${cfg.one.slice(1)} (brouillon)`} subtitle={<Badge tone={STATUS[doc.status][1]}>{STATUS[doc.status][0]}</Badge>}
        actions={<div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy === 'pdf'} onClick={() => run('pdf', () => downloadCsv(`${cfg.api}/${id}/pdf`, undefined, `${doc.number ?? 'brouillon'}.pdf`))}><Printer size={16} aria-hidden /> Imprimer (PDF)</Button>
          {draft && can('stock.write') && <Button variant="secondary" onClick={() => setModal('edit')}><Pencil size={16} aria-hidden /> Modifier</Button>}
          {draft && can('stock.validate') && <Button loading={busy === 'validate'} onClick={() => run('validate', () => api.post(`${cfg.api}/${id}/validate`), 'Bon validé : le stock a été mis à jour')}><CheckCircle2 size={16} aria-hidden /> Valider</Button>}
          {doc.status === 'validated' && can('stock.validate') && <Button variant="secondary" onClick={() => setModal('cancel')}><Ban size={16} aria-hidden /> Annuler</Button>}
          {draft && can('stock.delete') && <Button variant="ghost" onClick={() => setModal('delete')}><Trash2 size={16} className="text-red-600" aria-hidden /> Supprimer</Button>}
        </div>} />
      <div className="mb-4 space-y-3"><Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert>
        {doc.status === 'cancelled' && <Alert tone="error">Bon annulé — motif : {doc.cancelReason}. Des mouvements inverses ont été enregistrés.</Alert>}</div>
      <Card className="min-w-0 p-5">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div><dt className="text-slate-500">Date</dt><dd>{fmtDate(doc.date)}</dd></div>
          <div><dt className="text-slate-500">{type === 'transfer' ? 'Origine' : 'Entrepôt'}</dt><dd>{doc.warehouse.name}</dd></div>
          {doc.toWarehouse && <div><dt className="text-slate-500">Destination</dt><dd>{doc.toWarehouse.name}</dd></div>}
          {doc.reason && <div><dt className="text-slate-500">Motif</dt><dd>{doc.reason}</dd></div>}
        </dl>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[480px] text-left text-sm">
          <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Article</th><th className="px-3 py-2 text-right">Quantité</th>{cfg.cost && <th className="px-3 py-2 text-right">Coût unitaire HT</th>}</tr></thead>
          <tbody className="divide-y divide-slate-100">{doc.lines.map((l) => <tr key={l.id}><td className="px-3 py-2">{l.name} <span className="font-mono text-xs text-slate-500">{l.sku}</span></td><td className="px-3 py-2 text-right tabular-nums">{num(l.quantity)} {l.unit}</td>{cfg.cost && <td className="px-3 py-2 text-right tabular-nums">{l.unitCost ? fmtMoney(l.unitCost, '') : 'prix d\'achat ou coût moyen'}</td>}</tr>)}</tbody></table></div>
        {doc.notes && <p className="mt-4 whitespace-pre-line text-sm text-slate-600">{doc.notes}</p>}
      </Card>
      <Card className="mt-4 p-5">
        <button className="flex w-full items-center gap-2 text-sm font-semibold" onClick={async () => setHist(hist ? null : (await api.get(`${cfg.api}/${id}/history`)).data.data)}><History size={16} aria-hidden /> Historique</button>
        {hist && <ul className="mt-3 space-y-2 text-sm">{hist.map((h, i) => <li key={i}><span className="font-medium">{h.action}</span> <span className="text-slate-500">· {h.by ?? 'système'} · {new Date(h.at).toLocaleString('fr-FR')}</span></li>)}</ul>}
      </Card>
      {modal === 'edit' && <VoucherForm type={type} initial={doc} warehouses={warehouses} onClose={() => setModal(null)} onDone={() => { setModal(null); setNotice({ tone: 'success', text: 'Brouillon enregistré' }); load(); }} />}
      {modal === 'cancel' && (
        <Modal title={`Annuler le bon ${doc.number}`} onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-slate-600">Des mouvements inverses sont enregistrés (le bon reste consultable). Impossible si le stock correspondant a déjà été consommé.</p>
          <input aria-label="Motif d'annulation" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder="Motif (obligatoire)" className={field} />
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Retour</Button><Button variant="danger" disabled={reason.trim().length < 5} onClick={async () => { setModal(null); await run('cancel', () => api.post(`${cfg.api}/${id}/cancel`, { reason }), 'Bon annulé'); }}>Annuler le bon</Button></div>
        </Modal>)}
      {modal === 'delete' && (
        <Modal title="Supprimer ce brouillon ?" onClose={() => setModal(null)}>
          <p className="text-sm text-slate-600">Aucun mouvement n'a été enregistré : la suppression est sans effet sur le stock.</p>
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button variant="danger" onClick={async () => { try { await api.delete(`${cfg.api}/${id}`); navigate(cfg.base); } catch (e) { setModal(null); setNotice({ tone: 'error', text: errorMessage(e) }); } }}>Supprimer</Button></div>
        </Modal>)}
    </>
  );
}

// ---------------- Fiches d'inventaire
export function CountListPage() {
  const { can } = useAuth(); const navigate = useNavigate(); const warehouses = useWarehouses();
  const [state, setState] = useState({ loading: true }); const [page, setPage] = useState(1); const [form, setForm] = useState(false);
  const [wh, setWh] = useState(''); const [date, setDate] = useState(todayIso()); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/stock/counts', { params: { page, limit: 15 } }).then((r) => setState({ rows: r.data.data, meta: r.data.meta })).catch((e) => setState({ error: errorMessage(e) })); }, [page]);
  const active = warehouses.filter((w) => w.status === 'active');
  const create = async () => { setBusy(true); setError(''); try { navigate(`/stock/sheets/${(await api.post('/stock/counts', { warehouseId: wh || active.find((w) => w.isDefault)?.id || active[0]?.id, date })).data.data.id}`); } catch (e) { setError(errorMessage(e)); setBusy(false); } };
  return (
    <>
      <PageHeader title="Fiches d'inventaire" subtitle="Comptez le stock physique d'un entrepôt ; la validation ajuste les écarts avec un motif et les trace dans les mouvements." actions={can('stock.write') && <Button onClick={() => setForm(true)}><Plus size={16} aria-hidden /> Nouvelle fiche</Button>} />
      <Card>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <EmptyState icon={Boxes} title="Aucune fiche d'inventaire">Ouvrez une fiche pour compter un entrepôt.</EmptyState> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Numéro</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Entrepôt</th><th className="px-4 py-3">Comptage</th><th className="px-4 py-3">Statut</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((r) => <tr key={r.id} className="hover:bg-slate-50"><td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`/stock/sheets/${r.id}`}>{r.number ?? 'Brouillon'}</Link></td><td className="px-4 py-3">{fmtDate(r.date)}</td><td className="px-4 py-3">{r.warehouse}</td><td className="px-4 py-3">{r.countedCount}/{r.lineCount} articles</td><td className="px-4 py-3"><Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge></td></tr>)}</tbody></table></div>)}
        <Pagination meta={state.meta} onPage={setPage} />
      </Card>
      {form && (
        <Modal title="Nouvelle fiche d'inventaire" onClose={() => setForm(false)}>
          <div className="space-y-4"><Alert tone="error">{error}</Alert>
            <WhSelect id="c-wh" label="Entrepôt" value={wh || active.find((w) => w.isDefault)?.id || active[0]?.id || ''} onChange={setWh} list={active} />
            <div><label htmlFor="c-date" className="mb-1 block text-sm font-medium">Date du comptage</label><input id="c-date" type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} className={field} /></div>
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setForm(false)}>Annuler</Button><Button loading={busy} onClick={create}>Ouvrir la fiche</Button></div></div>
        </Modal>)}
    </>
  );
}

export function CountViewPage() {
  const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth();
  const [doc, setDoc] = useState(null); const [counts, setCounts] = useState({}); const [error, setError] = useState(''); const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [busy, setBusy] = useState(''); const [modal, setModal] = useState(null); const [reason, setReason] = useState('');
  const load = useCallback(async () => { try { const d = (await api.get(`/stock/counts/${id}`)).data.data; setDoc(d); setCounts(Object.fromEntries(d.lines.map((l) => [l.productId, l.countedQuantity === null ? '' : String(Number(l.countedQuantity))]))); } catch (e) { setError(errorMessage(e)); } }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!doc) return <Spinner />;
  const draft = doc.status === 'draft';
  const save = async () => { await api.put(`/stock/counts/${id}/lines`, { lines: doc.lines.map((l) => ({ productId: l.productId, countedQuantity: counts[l.productId] === '' ? null : counts[l.productId] })) }); };
  const run = async (key, fn, ok) => { setBusy(key); setNotice({ tone: 'success', text: '' }); try { await fn(); setNotice({ tone: 'success', text: ok }); await load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(''); } };
  const diff = (l) => (counts[l.productId] === '' || counts[l.productId] === undefined ? null : Number(String(counts[l.productId]).replace(',', '.')) - Number(draft ? l.currentQuantity : l.expectedQuantity));
  return (
    <>
      <PageHeader title={doc.number ?? "Fiche d'inventaire (brouillon)"} subtitle={<span className="inline-flex items-center gap-2"><Badge tone={STATUS[doc.status][1]}>{STATUS[doc.status][0]}</Badge><span>{doc.warehouse.name} · {fmtDate(doc.date)}</span></span>}
        actions={draft && <div className="flex flex-wrap gap-2">
          {can('stock.write') && <Button variant="secondary" loading={busy === 'save'} onClick={() => run('save', save, 'Comptage enregistré')}>Enregistrer le comptage</Button>}
          {can('stock.validate') && <Button onClick={async () => { try { await save(); setModal('validate'); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } }}><CheckCircle2 size={16} aria-hidden /> Valider les écarts</Button>}
          {can('stock.delete') && <Button variant="ghost" onClick={() => setModal('delete')}><Trash2 size={16} className="text-red-600" aria-hidden /> Supprimer</Button>}</div>} />
      <div className="mb-4"><Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert></div>
      {draft && <Alert tone="info">Saisissez la quantité comptée ; laissez vide les articles que vous ne comptez pas (ils ne seront pas ajustés). L'écart est calculé à la validation sur le stock réel du moment.</Alert>}
      {doc.status === 'validated' && <Alert tone="info">Fiche validée : motif « {doc.reason} ». Les écarts sont dans le journal des mouvements. Elle ne peut plus être modifiée.</Alert>}
      <Card className="mt-4 min-w-0"><div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Article</th><th className="px-4 py-3 text-right">{draft ? 'Stock actuel' : 'Théorique'}</th><th className="px-4 py-3 text-right">Compté</th><th className="px-4 py-3 text-right">Écart</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{doc.lines.map((l) => { const d = diff(l); return (
          <tr key={l.id}><td className="px-4 py-3">{l.name} <span className="font-mono text-xs text-slate-500">{l.sku}</span></td><td className="px-4 py-3 text-right tabular-nums">{num(draft ? l.currentQuantity : l.expectedQuantity)}</td>
            <td className="px-4 py-3 text-right">{draft ? <input aria-label={`Quantité comptée ${l.name}`} inputMode="decimal" value={counts[l.productId] ?? ''} onChange={(e) => setCounts({ ...counts, [l.productId]: e.target.value })} className="w-28 rounded-md border border-slate-300 px-2 py-1 text-right tabular-nums" /> : <span className="tabular-nums">{l.countedQuantity === null ? '—' : num(l.countedQuantity)}</span>}</td>
            <td className={`px-4 py-3 text-right tabular-nums font-medium ${d === null || d === 0 ? 'text-slate-400' : d < 0 ? 'text-red-700' : 'text-green-700'}`}>{d === null ? '—' : `${d > 0 ? '+' : ''}${num(d)}`}</td></tr>); })}</tbody></table></div></Card>
      {modal === 'validate' && (
        <Modal title="Valider l'inventaire" onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-slate-600">Les écarts seront enregistrés comme mouvements d'inventaire. Cette action est définitive.</p>
          <label htmlFor="c-reason" className="mb-1 block text-sm font-medium">Motif de l'ajustement *</label><input id="c-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} className={field} placeholder="Ex. inventaire annuel" />
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Retour</Button><Button disabled={reason.trim().length < 3} onClick={async () => { setModal(null); await run('validate', () => api.post(`/stock/counts/${id}/validate`, { reason }), 'Inventaire validé : écarts ajustés'); }}>Valider définitivement</Button></div>
        </Modal>)}
      {modal === 'delete' && (
        <Modal title="Supprimer cette fiche ?" onClose={() => setModal(null)}>
          <p className="text-sm text-slate-600">Le brouillon est supprimé sans effet sur le stock.</p>
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button variant="danger" onClick={async () => { try { await api.delete(`/stock/counts/${id}`); navigate('/stock/sheets'); } catch (e) { setModal(null); setNotice({ tone: 'error', text: errorMessage(e) }); } }}>Supprimer</Button></div>
        </Modal>)}
    </>
  );
}

// ---------------- Entrepôts
export function WarehousesPage() {
  const { can } = useAuth(); const [state, setState] = useState({ loading: true }); const [form, setForm] = useState(null); const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const load = useCallback(() => api.get('/stock/warehouses').then((r) => setState({ rows: r.data.data })).catch((e) => setState({ error: errorMessage(e) })), []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, ok) => { try { await fn(); setNotice({ tone: 'success', text: ok }); await load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } };
  const write = can('stock.write');
  return (
    <>
      <PageHeader title="Entrepôts" subtitle="Lieux de stockage. Un entrepôt principal est créé automatiquement ; les livraisons sortent de l'entrepôt choisi sur le bon." actions={write && <Button onClick={() => setForm({})}><Plus size={16} aria-hidden /> Nouvel entrepôt</Button>} />
      <div className="mb-4"><Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert></div>
      <Card>
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Code</th><th className="px-4 py-3">Nom</th><th className="px-4 py-3">Adresse</th><th className="px-4 py-3">Articles en stock</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((w) => (
              <tr key={w.id}><td className="px-4 py-3 font-mono text-xs">{w.code}</td><td className="px-4 py-3 font-medium">{w.name} {w.isDefault && <Badge tone="blue">Par défaut</Badge>}</td><td className="px-4 py-3">{w.address ?? '—'}</td><td className="px-4 py-3">{w.productCount}</td><td className="px-4 py-3"><Badge tone={w.status === 'active' ? 'green' : 'neutral'}>{w.status === 'active' ? 'Actif' : 'Archivé'}</Badge></td>
                <td className="px-4 py-3"><div className="flex justify-end gap-1">{write && <Button variant="ghost" aria-label={`Modifier ${w.name}`} onClick={() => setForm(w)}><Pencil size={15} /></Button>}
                  {write && w.status === 'active' && <Button variant="ghost" aria-label={`Archiver ${w.name}`} onClick={() => act(() => api.post(`/stock/warehouses/${w.id}/archive`), 'Entrepôt archivé')}><Archive size={15} /></Button>}
                  {write && w.status === 'archived' && <Button variant="ghost" onClick={() => act(() => api.post(`/stock/warehouses/${w.id}/restore`), 'Entrepôt restauré')}>Restaurer</Button>}</div></td></tr>))}</tbody></table></div>)}
      </Card>
      {form && <WarehouseForm initial={form.id ? form : null} onClose={() => setForm(null)} onDone={(w) => { setForm(null); setNotice({ tone: 'success', text: `Entrepôt « ${w.name} » enregistré` }); load(); }} />}
    </>
  );
}
function WarehouseForm({ initial, onClose, onDone }) {
  const [f, setF] = useState({ code: initial?.code ?? '', name: initial?.name ?? '', address: initial?.address ?? '', isDefault: initial?.isDefault ?? false });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); setError(''); const body = { ...f, address: f.address || null }; try { onDone((initial ? await api.put(`/stock/warehouses/${initial.id}`, body) : await api.post('/stock/warehouses', body)).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); } };
  return (
    <Modal title={initial ? "Modifier l'entrepôt" : 'Nouvel entrepôt'} onClose={onClose}>
      <div className="space-y-4"><Alert tone="error">{error}</Alert>
        <div><label htmlFor="w-code" className="mb-1 block text-sm font-medium">Code *</label><input id="w-code" value={f.code} maxLength={20} onChange={(e) => setF({ ...f, code: e.target.value })} className={field} placeholder="Ex. SFAX" /></div>
        <div><label htmlFor="w-name" className="mb-1 block text-sm font-medium">Nom *</label><input id="w-name" value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} className={field} /></div>
        <div><label htmlFor="w-addr" className="mb-1 block text-sm font-medium">Adresse</label><input id="w-addr" value={f.address} maxLength={255} onChange={(e) => setF({ ...f, address: e.target.value })} className={field} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} /> Entrepôt par défaut</label>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={f.code.trim().length < 2 || f.name.trim().length < 2} onClick={submit}>Enregistrer</Button></div></div>
    </Modal>
  );
}
