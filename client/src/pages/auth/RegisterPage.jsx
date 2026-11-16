import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { errorCode, errorMessage } from '../../services/api.js';
import { Alert, Button, Input } from '../../components/ui/index.jsx';
import { Heading, PASSWORD_HINT, passwordRules } from './parts.jsx';

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
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema) });

  const onSubmit = async ({ confirm, taxId, ...values }) => {
    setError('');
    try {
      await signUp({ ...values, ...(taxId ? { taxId } : {}) });
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
