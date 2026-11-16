import { useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Archive, ArchiveRestore, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Select, Spinner } from '../../components/ui/index.jsx';
import { ExportButton, ImportModal, Pagination, useDebounced } from './shared.jsx';

const blank = (v) => (v === '' ? null : v);
const schema = z.object({
  name: z.string().trim().min(2, 'Nom trop court (2 caractères minimum)').max(190),
  type: z.enum(['individual', 'company']),
  taxId: z.string().trim().max(50).regex(/^[A-Za-z0-9/ .-]*$/, 'Caractères non autorisés'),
  tradeRegister: z.string().trim().max(60),
  address: z.string().trim().max(255),
  governorate: z.string().trim().max(100),
  postalCode: z.string().trim().max(20),
  phone: z.string().trim().max(40).regex(/^([0-9+()\s.-]{4,})?$/, 'Téléphone invalide'),
  email: z.string().trim().max(190).refine((v) => v === '' || z.string().email().safeParse(v).success, 'E-mail invalide'),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Code ISO à 2 lettres'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Code ISO à 3 lettres'),
  paymentTermsDays: z.coerce.number({ invalid_type_error: 'Nombre requis' }).int().min(0).max(365),
  notes: z.string().trim().max(5000),
});
const TEXT_FIELDS = ['taxId', 'tradeRegister', 'address', 'governorate', 'postalCode', 'phone', 'email', 'notes'];
const toForm = (p) => ({ name: '', type: 'company', country: 'TN', currency: 'TND', paymentTermsDays: 0, ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, p?.[k] ?? ''])), ...(p ? { name: p.name, type: p.type, country: p.country, currency: p.currency, paymentTermsDays: p.paymentTermsDays } : {}) });

function PartyForm({ cfg, party, onClose, onSaved }) {
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema), defaultValues: toForm(party) });
  const submit = async (v) => {
    setError('');
    const body = { ...v, ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, blank(v[k])])) };
    try {
      const r = party ? await api.patch(`${cfg.api}/${party.id}`, body) : await api.post(cfg.api, body);
      onSaved(r.data.data, !party);
    } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal title={party ? `Modifier ${cfg.one} ${party.code}` : `Nouveau ${cfg.one}`} onClose={onClose} size="lg">
      <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
        <Alert tone="error">{error}</Alert>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input className="sm:col-span-2" label="Nom / raison sociale *" error={errors.name?.message} {...register('name')} />
          <Select label="Type" {...register('type')}><option value="company">Entreprise</option><option value="individual">Particulier</option></Select>
          <Input label="Matricule fiscal" placeholder="1234567/A/M/000" error={errors.taxId?.message} {...register('taxId')} />
          <Input label="Registre de commerce" error={errors.tradeRegister?.message} {...register('tradeRegister')} />
          <Input label="Téléphone" type="tel" error={errors.phone?.message} {...register('phone')} />
          <Input className="sm:col-span-2" label="E-mail" type="email" error={errors.email?.message} {...register('email')} />
          <Input className="sm:col-span-2" label="Adresse" error={errors.address?.message} {...register('address')} />
          <Input label="Gouvernorat" error={errors.governorate?.message} {...register('governorate')} />
          <Input label="Code postal" error={errors.postalCode?.message} {...register('postalCode')} />
          <Input label="Pays (ISO)" error={errors.country?.message} {...register('country')} />
          <Input label="Devise (ISO)" error={errors.currency?.message} {...register('currency')} />
          <Input label="Délai de paiement (jours)" type="number" min="0" hint="0 = au comptant" error={errors.paymentTermsDays?.message} {...register('paymentTermsDays')} />
          <div className="sm:col-span-2">
            <label htmlFor="notes" className="mb-1 block text-sm font-medium text-slate-700">Notes internes</label>
            <textarea id="notes" rows={3} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25" {...register('notes')} />
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

export default function PartiesPage({ cfg }) {
  const { can } = useAuth();
  const [filters, setFilters] = useState({ q: '', status: 'active', page: 1 });
  const q = useDebounced(filters.q);
  const [state, setState] = useState({ loading: true });
  const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [params, setParams] = useSearchParams();
  const [form, setForm] = useState(() => (params.get('new') && can(`${cfg.perm}.write`) ? {} : null));
  useEffect(() => { if (params.get('new')) { params.delete('new'); setParams(params, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [importing, setImporting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get(cfg.api, { params: { q: q || undefined, status: filters.status || undefined, page: filters.page, limit: 15 } });
      setState({ rows: r.data.data, meta: r.data.meta });
    } catch (e) { setState({ error: errorMessage(e) }); }
  }, [cfg.api, q, filters.status, filters.page]);
  useEffect(() => { load(); }, [load]);

  const flash = (text, tone = 'success') => setNotice({ tone, text });
  const archive = async (p) => {
    try { await api.patch(`${cfg.api}/${p.id}`, { status: p.status === 'active' ? 'archived' : 'active' }); flash(p.status === 'active' ? `${p.name} archivé` : `${p.name} restauré`); load(); } catch (e) { flash(errorMessage(e), 'error'); }
  };
  const remove = async (p) => {
    try { await api.delete(`${cfg.api}/${p.id}`); flash(`${p.name} supprimé`); setConfirmDel(null); load(); } catch (e) { setConfirmDel(null); flash(errorMessage(e), 'error'); }
  };

  return (
    <>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle}
        actions={<div className="flex flex-wrap gap-2">
          <ExportButton path={`${cfg.api}/export.csv`} params={{ q: q || undefined, status: filters.status || undefined }} filename={`${cfg.file}.csv`} onError={(t) => flash(t, 'error')} />
          {can(`${cfg.perm}.write`) && <Button variant="secondary" onClick={() => setImporting(true)}><Upload size={16} aria-hidden /> Importer</Button>}
          {can(`${cfg.perm}.write`) && <Button onClick={() => setForm({})}><Plus size={16} aria-hidden /> Nouveau</Button>}
        </div>} />
      <div className="mb-4"><Alert tone={notice.tone} onClose={() => flash('')}>{notice.text}</Alert></div>

      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search size={16} className="absolute left-3 top-2.5 text-slate-400" aria-hidden />
            <input aria-label="Rechercher" placeholder="Nom, code, matricule, e-mail, téléphone…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value, page: 1 })}
              className="block w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25" />
          </div>
          <select aria-label="Statut" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value, page: 1 })} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="active">Actifs</option><option value="archived">Archivés</option><option value="">Tous</option>
          </select>
        </div>

        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={cfg.icon} title={filters.q || filters.status !== 'active' ? 'Aucun résultat' : `Aucun ${cfg.one} pour l'instant`}
            action={!filters.q && can(`${cfg.perm}.write`) && <Button onClick={() => setForm({})}><Plus size={16} aria-hidden /> Créer {cfg.article} {cfg.one}</Button>}>
            {filters.q ? 'Modifiez votre recherche ou vos filtres.' : 'Créez-en un ou importez un fichier CSV.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                <tr><th className="px-4 py-3">Code</th><th className="px-4 py-3">Nom</th><th className="px-4 py-3">Matricule fiscal</th><th className="px-4 py-3">Contact</th><th className="px-4 py-3">Paiement</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3 text-right">Actions</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.rows.map((p) => (
                  <tr key={p.id} className={p.status === 'archived' ? 'bg-slate-50 text-slate-500' : ''}>
                    <td className="px-4 py-3 font-mono text-xs">{p.code}</td>
                    <td className="px-4 py-3"><div className="font-medium text-slate-900">{p.name}</div><div className="text-xs text-slate-500">{p.type === 'individual' ? 'Particulier' : 'Entreprise'}{p.governorate ? ` · ${p.governorate}` : ''}</div></td>
                    <td className="px-4 py-3">{p.taxId ?? '—'}</td>
                    <td className="px-4 py-3"><div>{p.email ?? '—'}</div><div className="text-xs text-slate-500">{p.phone ?? ''}</div></td>
                    <td className="px-4 py-3">{p.paymentTermsDays ? `${p.paymentTermsDays} j` : 'Comptant'}</td>
                    <td className="px-4 py-3"><Badge tone={p.status === 'active' ? 'green' : 'neutral'}>{p.status === 'active' ? 'Actif' : 'Archivé'}</Badge></td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {can(`${cfg.perm}.write`) && <>
                          <Button variant="ghost" aria-label={`Modifier ${p.name}`} onClick={() => setForm({ party: p })}><Pencil size={15} /></Button>
                          <Button variant="ghost" aria-label={`${p.status === 'active' ? 'Archiver' : 'Restaurer'} ${p.name}`} onClick={() => archive(p)}>{p.status === 'active' ? <Archive size={15} /> : <ArchiveRestore size={15} />}</Button>
                        </>}
                        {can(`${cfg.perm}.delete`) && <Button variant="ghost" aria-label={`Supprimer ${p.name}`} onClick={() => setConfirmDel(p)}><Trash2 size={15} className="text-red-600" /></Button>}
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

      {form && <PartyForm cfg={cfg} party={form.party} onClose={() => setForm(null)} onSaved={(p, created) => { setForm(null); flash(created ? `${p.code} créé` : `${p.name} mis à jour`); load(); }} />}
      {importing && <ImportModal path={cfg.api} title={`Importer des ${cfg.plural}`} columnsHint="Colonnes reconnues : Nom (obligatoire), Type, Matricule fiscal, Registre de commerce, Adresse, Gouvernorat, Code postal, Téléphone, E-mail, Pays, Devise, Délai de paiement, Notes."
        onClose={() => setImporting(false)} onDone={(r) => { setImporting(false); flash(`${r.created} ${cfg.plural} importé(s)`); load(); }} />}
      {confirmDel && (
        <Modal title="Supprimer définitivement ?" onClose={() => setConfirmDel(null)}>
          <p className="text-sm text-slate-600">« {confirmDel.name} » sera supprimé. S'il est déjà utilisé dans des documents, la suppression sera refusée : archivez-le plutôt.</p>
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setConfirmDel(null)}>Annuler</Button><Button variant="danger" onClick={() => remove(confirmDel)}>Supprimer</Button></div>
        </Modal>
      )}
    </>
  );
}
