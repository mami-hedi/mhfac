import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, Input, Modal, PageHeader, Select, Spinner } from '../../components/ui/index.jsx';

const KINDS = { standard: 'Standard', exempt: 'Exonéré', suspended: 'Suspension' };
const schema = z.object({
  name: z.string().trim().min(1, 'Nom requis').max(60),
  rate: z.string().trim().refine((v) => /^\d{1,3}([.,]\d{1,2})?$/.test(v) && Number(v.replace(',', '.')) <= 100, 'Taux entre 0 et 100 (2 décimales max)'),
  kind: z.enum(['standard', 'exempt', 'suspended']),
  notes: z.string().trim().max(255),
}).refine((v) => v.kind === 'standard' || Number(v.rate.replace(',', '.')) === 0, { path: ['rate'], message: 'Un taux exonéré ou suspendu doit être à 0' });

function RateForm({ rate, onClose, onSaved }) {
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema), defaultValues: { name: rate?.name ?? '', rate: rate?.rate ?? '', kind: rate?.kind ?? 'standard', notes: rate?.notes ?? '' } });
  const submit = async (v) => {
    setError('');
    const body = { ...v, rate: v.rate.replace(',', '.'), notes: v.notes || null };
    try { rate ? await api.patch(`/tax-rates/${rate.id}`, body) : await api.post('/tax-rates', body); onSaved(); } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal title={rate ? 'Modifier le taux' : 'Nouveau taux de TVA'} onClose={onClose}>
      <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
        <Alert tone="error">{error}</Alert>
        <Input label="Libellé" error={errors.name?.message} {...register('name')} />
        <Input label="Taux (%)" inputMode="decimal" error={errors.rate?.message} {...register('rate')} />
        <Select label="Nature" {...register('kind')}>{Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Input label="Note interne" error={errors.notes?.message} {...register('notes')} />
        <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="secondary" onClick={onClose}>Annuler</Button><Button type="submit" loading={isSubmitting}>Enregistrer</Button></div>
      </form>
    </Modal>
  );
}

export default function TaxRatesPage() {
  const { can } = useAuth();
  const [state, setState] = useState({ loading: true });
  const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [form, setForm] = useState(null);
  const load = useCallback(async () => {
    try { setState({ rows: (await api.get('/tax-rates')).data.data }); } catch (e) { setState({ error: errorMessage(e) }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, ok) => { try { await fn(); setNotice({ tone: 'success', text: ok }); load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } };
  const edit = can('tax_rate.write');

  if (state.loading) return <Spinner />;
  if (state.error) return <Alert tone="error">{state.error}</Alert>;
  return (
    <>
      <PageHeader title="Taux de TVA" subtitle="Les taux sont des paramètres de votre entreprise : modifiez-les, désactivez-les ou ajoutez-en selon la réglementation en vigueur."
        actions={edit && <Button onClick={() => setForm({})}><Plus size={16} aria-hidden /> Nouveau taux</Button>} />
      <div className="mb-4 space-y-3">
        <Alert tone="info">Les valeurs proposées à la création sont indicatives : faites-les valider par votre comptable. Un taux modifié n'affecte que les futurs documents.</Alert>
        <Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Libellé</th><th className="px-4 py-3 text-right">Taux</th><th className="px-4 py-3">Nature</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3 text-right">Actions</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {state.rows.map((t) => (
              <tr key={t.id} className={t.isActive ? '' : 'bg-slate-50 text-slate-500'}>
                <td className="px-4 py-3 font-medium">{t.name} {t.isDefault && <Badge tone="blue">Par défaut</Badge>}</td>
                <td className="px-4 py-3 text-right tabular-nums">{Number(t.rate).toFixed(2)} %</td>
                <td className="px-4 py-3">{KINDS[t.kind]}</td>
                <td className="px-4 py-3"><Badge tone={t.isActive ? 'green' : 'neutral'}>{t.isActive ? 'Actif' : 'Désactivé'}</Badge></td>
                <td className="px-4 py-3"><div className="flex justify-end gap-1">
                  {edit && <>
                    <Button variant="ghost" aria-label={`Modifier ${t.name}`} onClick={() => setForm({ rate: t })}><Pencil size={15} /></Button>
                    {!t.isDefault && t.isActive && <Button variant="ghost" aria-label={`Définir ${t.name} par défaut`} onClick={() => act(() => api.patch(`/tax-rates/${t.id}`, { isDefault: true }), `${t.name} est le taux par défaut`)}><Star size={15} /></Button>}
                    {!t.isDefault && <Button variant="ghost" onClick={() => act(() => api.patch(`/tax-rates/${t.id}`, { isActive: !t.isActive }), t.isActive ? 'Taux désactivé' : 'Taux réactivé')}>{t.isActive ? 'Désactiver' : 'Réactiver'}</Button>}
                  </>}
                  {can('tax_rate.delete') && !t.isDefault && <Button variant="ghost" aria-label={`Supprimer ${t.name}`} onClick={() => act(() => api.delete(`/tax-rates/${t.id}`), 'Taux supprimé')}><Trash2 size={15} className="text-red-600" /></Button>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {form && <RateForm rate={form.rate} onClose={() => setForm(null)} onSaved={() => { setForm(null); setNotice({ tone: 'success', text: 'Taux enregistré' }); load(); }} />}
    </>
  );
}
