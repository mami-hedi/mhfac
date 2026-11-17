import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { errorCode, errorMessage } from '../../services/api.js';
import { Alert, Button, Input } from '../../components/ui/index.jsx';
import { Heading, PASSWORD_HINT, passwordRules } from './parts.jsx';
import { usePublicPlans } from '../landing/plans.js';
import { cn } from '../../utils/format.js';

const schema = z.object({
  companyName: z.string().trim().min(2, 'Nom de l\'entreprise requis').max(190),
  taxId: z.string().trim().max(50).optional(),
  fullName: z.string().trim().min(2, 'Votre nom est requis').max(190),
  email: z.string().trim().min(1, 'E-mail requis').email('E-mail invalide'),
  password: passwordRules,
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Les mots de passe ne correspondent pas' });

export default function RegisterPage() {
  const { register: signUp } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [params] = useSearchParams();
  const plans = usePublicPlans();
  const offers = (plans ?? []).filter((p) => p.priced); // les offres « sur demande » passent par un contact, pas par l'inscription
  const [chosen, setChosen] = useState(params.get('plan') || 'pro');
  const planCode = offers.find((p) => p.code === chosen)?.code ?? (offers.find((p) => p.hot) ?? offers[0])?.code;
  const plan = offers.find((p) => p.code === planCode);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema) });

  const onSubmit = async ({ confirm, taxId, ...values }) => {
    setError('');
    try {
      await signUp({ ...values, ...(taxId ? { taxId } : {}), ...(planCode ? { planCode } : {}) });
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorCode(e) === 'EMAIL_TAKEN' ? 'Cette adresse e-mail est déjà utilisée. Connectez-vous ou utilisez une autre adresse.' : errorMessage(e));
    }
  };

  return (
    <>
      <Heading title="Créer votre entreprise">Vous deviendrez propriétaire de l'espace et pourrez inviter vos collaborateurs. Essai gratuit à l'inscription : aucun paiement n'est demandé.</Heading>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Alert tone="error">{error}</Alert>
        {offers.length > 0 && (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">Votre offre</legend>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Choisir votre offre">
              {offers.map((p) => (
                <label key={p.code} className={cn('cursor-pointer rounded-lg border p-3 text-sm transition', p.code === planCode ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-600/20' : 'border-slate-200 hover:border-slate-300')}>
                  <input type="radio" name="plan" value={p.code} checked={p.code === planCode} onChange={() => setChosen(p.code)} className="sr-only" />
                  <span className="block font-semibold text-slate-900">{p.n}{p.hot && <span className="ml-1.5 rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">Populaire</span>}</span>
                  <span className="mt-0.5 block text-slate-700">{p.p} {p.cur} / mois</span>
                  <span className="mt-1 block text-xs text-slate-500">{p.f.filter(([, ok]) => ok).slice(0, 2).map(([x]) => x).join(' · ')}</span>
                </label>
              ))}
            </div>
            {plan && <p className="mt-2 text-xs text-slate-600">Vous commencez par <strong>14 jours d'essai gratuit</strong> avec l'offre <strong>{plan.n}</strong>, sans carte bancaire. Ensuite : {plan.p} {plan.cur} / mois{plan.y ? ` ou ${plan.y}` : ''}. Vous pourrez changer d'offre depuis Abonnement.</p>}
          </fieldset>
        )}
        <Input label="Nom de l'entreprise" autoComplete="organization" error={errors.companyName?.message} {...register('companyName')} />
        <Input label="Matricule fiscal (facultatif)" error={errors.taxId?.message} {...register('taxId')} />
        <Input label="Votre nom complet" autoComplete="name" error={errors.fullName?.message} {...register('fullName')} />
        <Input label="Adresse e-mail" type="email" autoComplete="email" error={errors.email?.message} {...register('email')} />
        <Input label="Mot de passe" type="password" autoComplete="new-password" hint={PASSWORD_HINT} error={errors.password?.message} {...register('password')} />
        <Input label="Confirmer le mot de passe" type="password" autoComplete="new-password" error={errors.confirm?.message} {...register('confirm')} />
        <Button type="submit" loading={isSubmitting} className="w-full">Créer mon espace</Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        Déjà inscrit ? <Link to="/login" className="font-medium text-brand-600 hover:underline">Se connecter</Link>
      </p>
    </>
  );
}
