import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Card, Input, Select, Spinner } from '../../components/ui/index.jsx';
import LogoColorCard from './LogoColorCard.jsx';
import NumberingCard from './NumberingCard.jsx';

const area = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25 disabled:bg-slate-100';

export default function BillingSettings() {
  const { can } = useAuth(); const editable = can('settings.write');
  const [state, setState] = useState({ loading: true }); const [branding, setBranding] = useState(null);
  const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm();

  useEffect(() => {
    api.get('/companies/current/settings').then((r) => {
      const s = r.data.data; setBranding({ logo: s.branding.logo ?? null, accentColor: s.branding.accentColor, template: s.branding.template ?? 'classic' });
      reset({ ...s.identity, allowNegative: s.stock?.allowNegative ?? false, ...s.sales, stampDutyEnabled: s.sales.stampDutyEnabled });
      setState({ loading: false });
    }).catch((e) => setState({ error: errorMessage(e) }));
  }, [reset]);

  const submit = handleSubmit(async (v) => {
    setNotice({ tone: 'success', text: '' });
    try {
      await api.patch('/companies/current/settings', {
        identity: { address: v.address, governorate: v.governorate, postalCode: v.postalCode, phone: v.phone, email: v.email, website: v.website, tradeRegister: v.tradeRegister },
        stock: { allowNegative: !!v.allowNegative },
        sales: { fodecEnabled: !!v.fodecEnabled, fodecRate: String(v.fodecRate ?? '1.00').replace(',', '.'), stampDutyEnabled: v.stampDutyEnabled, stampDutyAmount: String(v.stampDutyAmount).replace(',', '.'), defaultWithholdingPct: String(v.defaultWithholdingPct).replace(',', '.'), quoteValidityDays: Number(v.quoteValidityDays), defaultPaymentTermsDays: Number(v.defaultPaymentTermsDays), defaultTerms: v.defaultTerms, legalMentions: v.legalMentions, paymentInfo: v.paymentInfo },
      });
      setNotice({ tone: 'success', text: 'Paramètres de facturation enregistrés.' });
    } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); }
  });

  if (state.loading) return <Spinner />;
  if (state.error) return <Alert tone="error">{state.error}</Alert>;
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Card className="p-5">
        <h2 className="mb-4 font-semibold text-slate-900">Coordonnées affichées sur les documents</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input className="sm:col-span-2" label="Adresse" disabled={!editable} {...register('address')} />
          <Input label="Gouvernorat" disabled={!editable} {...register('governorate')} />
          <Input label="Code postal" disabled={!editable} {...register('postalCode')} />
          <Input label="Téléphone" disabled={!editable} {...register('phone')} />
          <Input label="E-mail" disabled={!editable} {...register('email')} />
          <Input label="Site web" disabled={!editable} {...register('website')} />
          <Input label="Registre de commerce" disabled={!editable} {...register('tradeRegister')} />
        </div>
      </Card>
      <LogoColorCard editable={editable} initial={branding} />
      <NumberingCard editable={editable} />
      <Card className="p-5">
        <h2 className="mb-1 font-semibold text-slate-900">Fiscalité et conditions de vente</h2>
        <p className="mb-4 text-sm text-slate-500">Aucune valeur fiscale n'est imposée par MHFac : renseignez-les d'après votre situation et faites-les valider par votre comptable.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex items-center gap-2"><input id="stampOn" type="checkbox" className="h-4 w-4" disabled={!editable} {...register('stampDutyEnabled')} /><label htmlFor="stampOn" className="text-sm">Pré-cocher le timbre fiscal sur les nouveaux documents de vente <span className="text-slate-500">(reste décochable document par document ; jamais obligatoire)</span></label></div>
          <Input label="Montant du timbre fiscal (TND)" inputMode="decimal" disabled={!editable} {...register('stampDutyAmount')} />
          <div className="flex items-center gap-2 sm:col-span-2"><input id="fodecOn" type="checkbox" className="h-4 w-4" disabled={!editable} {...register('fodecEnabled')} /><label htmlFor="fodecOn" className="text-sm">Appliquer le FODEC sur les ventes <span className="text-slate-500">(Fonds de développement de la compétitivité industrielle : s'ajoute au HT des articles « soumis au FODEC », avant la TVA)</span></label></div>
          <Input label="Taux du FODEC (%)" inputMode="decimal" disabled={!editable} {...register('fodecRate')} />
          <Input label="Retenue à la source par défaut (%)" inputMode="decimal" disabled={!editable} {...register('defaultWithholdingPct')} />
          <Input label="Validité des devis (jours)" type="number" disabled={!editable} {...register('quoteValidityDays')} />
          <Input label="Délai de paiement par défaut (jours)" type="number" disabled={!editable} {...register('defaultPaymentTermsDays')} />
          <div className="sm:col-span-2"><label htmlFor="paymentInfo" className="mb-1 block text-sm font-medium">Coordonnées de règlement (RIB, etc.)</label><textarea id="paymentInfo" rows={2} className={area} disabled={!editable} {...register('paymentInfo')} /></div>
          <div className="sm:col-span-2"><label htmlFor="defaultTerms" className="mb-1 block text-sm font-medium">Conditions générales par défaut</label><textarea id="defaultTerms" rows={3} className={area} disabled={!editable} {...register('defaultTerms')} /></div>
          <div className="sm:col-span-2"><label htmlFor="legalMentions" className="mb-1 block text-sm font-medium">Mentions légales</label><textarea id="legalMentions" rows={3} className={area} disabled={!editable} {...register('legalMentions')} /></div>
        </div>
      </Card>
      {editable && (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
          <Button type="submit" loading={isSubmitting}>Enregistrer les paramètres de facturation</Button>
          <div className="min-w-0 flex-1"><Alert tone={notice.tone}>{notice.text}</Alert></div>
        </div>
      )}
    </form>
  );
}
