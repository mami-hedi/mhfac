import { useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Archive, ArchiveRestore, FolderCog, Package, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Select, Spinner } from '../../components/ui/index.jsx';
import { formatMoney } from '../../utils/format.js';
import { ExportButton, ImportModal, Pagination, useDebounced } from './shared.jsx';

const money = (scale, required) => z.string().trim().refine((v) => (v === '' ? !required : new RegExp(`^\\d{1,12}([.,]\\d{1,${scale}})?$`).test(v)), required ? `Montant positif requis (${scale} décimales max)` : `Nombre positif (${scale} décimales max)`);
const schema = z.object({
  name: z.string().trim().min(2, 'Nom trop court (2 caractères minimum)').max(190),
  sku: z.string().trim().max(60).regex(/^[A-Za-z0-9._/-]*$/, 'Lettres, chiffres, . _ / - uniquement'),
  barcode: z.string().trim().max(60).regex(/^[0-9A-Za-z-]*$/, 'Code-barres invalide'),
  description: z.string().trim().max(5000),
  type: z.enum(['product', 'service']),
  categoryId: z.string(),
  salePrice: money(3, true),
  purchasePrice: money(3, false),
  unit: z.string().trim().min(1, 'Unité requise').max(20),
  taxRateId: z.string().min(1, 'Taux de TVA requis'),
  trackStock: z.boolean(),
  fodecSubject: z.boolean(),
  stockAlertThreshold: money(4, false),
});
const nul = (v) => (v === '' ? null : v);

function ProductForm({ product, taxRates, categories, onClose, onSaved }) {
  const [error, setError] = useState('');
  const defaultTax = taxRates.find((t) => t.isDefault && t.isActive)?.id ?? '';
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: product ? {
      name: product.name, sku: product.sku, barcode: product.barcode ?? '', description: product.description ?? '', type: product.type, categoryId: product.category?.id ?? '',
      salePrice: product.salePrice, purchasePrice: product.purchasePrice ?? '', unit: product.unit, taxRateId: product.taxRate?.id ?? '', trackStock: product.trackStock, fodecSubject: !!product.fodecSubject, stockAlertThreshold: product.stockAlertThreshold ?? '',
    } : { name: '', sku: '', barcode: '', description: '', type: 'product', categoryId: '', salePrice: '0.000', purchasePrice: '', unit: 'unité', taxRateId: defaultTax, trackStock: false, fodecSubject: false, stockAlertThreshold: '' },
  });
  const type = watch('type'); const track = watch('trackStock');
  const submit = async (v) => {
    setError('');
    const body = { ...v, sku: product ? v.sku : nul(v.sku), barcode: nul(v.barcode), description: nul(v.description), categoryId: nul(v.categoryId), purchasePrice: nul(v.purchasePrice), stockAlertThreshold: nul(v.stockAlertThreshold) };
    try {
      const r = product ? await api.patch(`/products/${product.id}`, body) : await api.post('/products', body);
      onSaved(r.data.data, !product);
    } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal title={product ? `Modifier ${product.sku}` : 'Nouvel article'} onClose={onClose} size="lg">
      <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
        <Alert tone="error">{error}</Alert>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input className="sm:col-span-2" label="Désignation *" error={errors.name?.message} {...register('name')} />
          <Select label="Type" {...register('type')}><option value="product">Produit</option><option value="service">Service</option></Select>
          <Select label="Catégorie" {...register('categoryId')}><option value="">— Aucune —</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          <Input label="SKU / référence" hint={product ? undefined : 'Laissez vide pour une génération automatique'} error={errors.sku?.message} {...register('sku')} />
          <Input label="Code-barres" error={errors.barcode?.message} {...register('barcode')} />
          <Input label="Prix de vente HT (TND) *" inputMode="decimal" error={errors.salePrice?.message} {...register('salePrice')} />
          <Input label="Prix d'achat HT indicatif" inputMode="decimal" error={errors.purchasePrice?.message} {...register('purchasePrice')} />
          <Select label="TVA *" error={errors.taxRateId?.message} {...register('taxRateId')}>
            <option value="">— Choisir —</option>
            {taxRates.filter((t) => t.isActive || t.id === product?.taxRate?.id).map((t) => <option key={t.id} value={t.id}>{t.name}{t.isActive ? '' : ' (désactivé)'}</option>)}
          </Select>
          <Input label="Unité" error={errors.unit?.message} {...register('unit')} />
          {type === 'product' && (
            <div className="flex items-end gap-2 pb-2"><input id="trackStock" type="checkbox" className="h-4 w-4" {...register('trackStock')} /><label htmlFor="trackStock" className="text-sm text-slate-700">Suivre le stock</label></div>
          )}
          {type === 'product' && (
            <div className="flex items-end gap-2 pb-2"><input id="fodecSubject" type="checkbox" className="h-4 w-4" {...register('fodecSubject')} /><label htmlFor="fodecSubject" className="text-sm text-slate-700">Soumis au FODEC <span className="text-slate-500">(produit de la liste officielle)</span></label></div>
          )}
          {type === 'product' && track && <Input label="Seuil d'alerte de stock" inputMode="decimal" error={errors.stockAlertThreshold?.message} {...register('stockAlertThreshold')} />}
          <div className="sm:col-span-2">
            <label htmlFor="description" className="mb-1 block text-sm font-medium text-slate-700">Description</label>
            <textarea id="description" rows={3} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25" {...register('description')} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Annuler</Button>
          <Button type="submit" loading={isSubmitting}>Enregistrer</Button>
        </div>
      </form>
    </Modal>
  );
}

function CategoriesModal({ categories, canWrite, canDelete, onClose, onChanged }) {
  const [name, setName] = useState(''); const [error, setError] = useState('');
  const run = async (fn) => { setError(''); try { await fn(); await onChanged(); } catch (e) { setError(errorMessage(e)); } };
  return (
    <Modal title="Catégories d'articles" onClose={onClose}>
      <Alert tone="error">{error}</Alert>
      <ul className="my-3 divide-y divide-slate-100 text-sm">
        {categories.length === 0 && <li className="py-2 text-slate-500">Aucune catégorie.</li>}
        {categories.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2">
            <span>{c.name} <span className="text-xs text-slate-400">({c.productCount})</span></span>
            {canDelete && <Button variant="ghost" aria-label={`Supprimer la catégorie ${c.name}`} onClick={() => run(() => api.delete(`/product-categories/${c.id}`))}><Trash2 size={15} className="text-red-600" /></Button>}
          </li>
        ))}
      </ul>
      {canWrite && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(async () => { await api.post('/product-categories', { name }); setName(''); }); }}>
          <input aria-label="Nouvelle catégorie" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Nouvelle catégorie" className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <Button type="submit"><Plus size={16} aria-hidden /> Ajouter</Button>
        </form>
      )}
    </Modal>
  );
}

export default function ProductsPage() {
  const { can } = useAuth();
  const [filters, setFilters] = useState({ q: '', status: 'active', type: '', categoryId: '', page: 1 });
  const q = useDebounced(filters.q);
  const [state, setState] = useState({ loading: true });
  const [refs, setRefs] = useState({ taxRates: [], categories: [] });
  const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [urlParams, setUrlParams] = useSearchParams();
  const [form, setForm] = useState(() => (urlParams.get('new') && can('product.write') ? {} : null));
  useEffect(() => { if (urlParams.get('new')) { urlParams.delete('new'); setUrlParams(urlParams, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [importing, setImporting] = useState(false);
  const [cats, setCats] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);

  const loadRefs = useCallback(async () => {
    const [t, c] = await Promise.all([api.get('/tax-rates'), api.get('/product-categories')]);
    setRefs({ taxRates: t.data.data, categories: c.data.data });
  }, []);
  const params = { q: q || undefined, status: filters.status || undefined, type: filters.type || undefined, categoryId: filters.categoryId || undefined };
  const load = useCallback(async () => {
    try {
      const r = await api.get('/products', { params: { ...params, page: filters.page, limit: 15 } });
      setState({ rows: r.data.data, meta: r.data.meta });
    } catch (e) { setState({ error: errorMessage(e) }); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filters.status, filters.type, filters.categoryId, filters.page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadRefs().catch(() => {}); }, [loadRefs]);

  const flash = (text, tone = 'success') => setNotice({ tone, text });
  const set = (patch) => setFilters({ ...filters, ...patch, page: 1 });
  const archive = async (p) => {
    try { await api.patch(`/products/${p.id}`, { status: p.status === 'active' ? 'archived' : 'active' }); flash(p.status === 'active' ? `${p.name} archivé` : `${p.name} restauré`); load(); } catch (e) { flash(errorMessage(e), 'error'); }
  };
  const remove = async (p) => {
    try { await api.delete(`/products/${p.id}`); flash(`${p.name} supprimé`); setConfirmDel(null); load(); } catch (e) { setConfirmDel(null); flash(errorMessage(e), 'error'); }
  };

  return (
    <>
      <PageHeader title="Articles" subtitle="Produits et services, prix de vente HT, TVA et suivi de stock."
        actions={<div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setCats(true)}><FolderCog size={16} aria-hidden /> Catégories</Button>
          <ExportButton path="/products/export.csv" params={params} filename="articles.csv" onError={(t) => flash(t, 'error')} />
          {can('product.write') && <Button variant="secondary" onClick={() => setImporting(true)}><Upload size={16} aria-hidden /> Importer</Button>}
          {can('product.write') && <Button onClick={() => setForm({})}><Plus size={16} aria-hidden /> Nouvel article</Button>}
        </div>} />
      <div className="mb-4"><Alert tone={notice.tone} onClose={() => flash('')}>{notice.text}</Alert></div>

      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search size={16} className="absolute left-3 top-2.5 text-slate-400" aria-hidden />
            <input aria-label="Rechercher" placeholder="Désignation, SKU, code-barres…" value={filters.q} onChange={(e) => set({ q: e.target.value })}
              className="block w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25" />
          </div>
          <select aria-label="Type" value={filters.type} onChange={(e) => set({ type: e.target.value })} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Tous types</option><option value="product">Produits</option><option value="service">Services</option></select>
          <select aria-label="Catégorie" value={filters.categoryId} onChange={(e) => set({ categoryId: e.target.value })} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Toutes catégories</option>{refs.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select aria-label="Statut" value={filters.status} onChange={(e) => set({ status: e.target.value })} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="active">Actifs</option><option value="archived">Archivés</option><option value="">Tous</option></select>
        </div>

        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={Package} title={filters.q ? 'Aucun résultat' : "Aucun article pour l'instant"}
            action={!filters.q && can('product.write') && <Button onClick={() => setForm({})}><Plus size={16} aria-hidden /> Créer un article</Button>}>
            {filters.q ? 'Modifiez votre recherche ou vos filtres.' : 'Créez vos produits et services ou importez un fichier CSV.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                <tr><th className="px-4 py-3">SKU</th><th className="px-4 py-3">Désignation</th><th className="px-4 py-3">Catégorie</th><th className="px-4 py-3 text-right">Prix HT</th><th className="px-4 py-3">TVA</th><th className="px-4 py-3">Stock</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3 text-right">Actions</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.rows.map((p) => (
                  <tr key={p.id} className={p.status === 'archived' ? 'bg-slate-50 text-slate-500' : ''}>
                    <td className="px-4 py-3 font-mono text-xs">{p.sku}</td>
                    <td className="px-4 py-3"><div className="font-medium text-slate-900">{p.name}</div><div className="text-xs text-slate-500">{p.type === 'service' ? 'Service' : 'Produit'} · {p.unit}</div></td>
                    <td className="px-4 py-3">{p.category?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatMoney(p.salePrice)}</td>
                    <td className="px-4 py-3">{p.taxRate?.name ?? '—'}</td>
                    <td className="px-4 py-3">{p.trackStock ? <Badge tone="blue">Suivi</Badge> : '—'}</td>
                    <td className="px-4 py-3"><Badge tone={p.status === 'active' ? 'green' : 'neutral'}>{p.status === 'active' ? 'Actif' : 'Archivé'}</Badge></td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {can('product.write') && <>
                          <Button variant="ghost" aria-label={`Modifier ${p.name}`} onClick={() => setForm({ product: p })}><Pencil size={15} /></Button>
                          <Button variant="ghost" aria-label={`${p.status === 'active' ? 'Archiver' : 'Restaurer'} ${p.name}`} onClick={() => archive(p)}>{p.status === 'active' ? <Archive size={15} /> : <ArchiveRestore size={15} />}</Button>
                        </>}
                        {can('product.delete') && <Button variant="ghost" aria-label={`Supprimer ${p.name}`} onClick={() => setConfirmDel(p)}><Trash2 size={15} className="text-red-600" /></Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination meta={state.meta} onPage={(page) => setFilters({ ...filters, page })} />
      </Card>

      {form && <ProductForm product={form.product} taxRates={refs.taxRates} categories={refs.categories} onClose={() => setForm(null)} onSaved={(p, created) => { setForm(null); flash(created ? `${p.sku} créé` : `${p.name} mis à jour`); load(); }} />}
      {importing && <ImportModal path="/products" title="Importer des articles" columnsHint="Colonnes reconnues : Nom (obligatoire), SKU, Code-barres, Type (produit/service), Catégorie (créée si absente), Prix de vente HT, Prix d'achat HT, Unité, TVA (nom ou taux existant), Suivi de stock (oui/non), Seuil d'alerte."
        onClose={() => setImporting(false)} onDone={(r) => { setImporting(false); flash(`${r.created} article(s) importé(s)`); load(); loadRefs(); }} />}
      {cats && <CategoriesModal categories={refs.categories} canWrite={can('product.write')} canDelete={can('product.delete')} onClose={() => setCats(false)} onChanged={loadRefs} />}
      {confirmDel && (
        <Modal title="Supprimer définitivement ?" onClose={() => setConfirmDel(null)}>
          <p className="text-sm text-slate-600">« {confirmDel.name} » sera supprimé. S'il est déjà utilisé dans des documents, archivez-le plutôt.</p>
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setConfirmDel(null)}>Annuler</Button><Button variant="danger" onClick={() => remove(confirmDel)}>Supprimer</Button></div>
        </Modal>
      )}
    </>
  );
}
