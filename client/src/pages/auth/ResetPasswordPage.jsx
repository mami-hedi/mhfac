import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Input } from '../../components/ui/index.jsx';
import { Heading, PASSWORD_HINT, passwordRules, queryToken } from './parts.jsx';

const schema = z.object({ password: passwordRules, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Les mots de passe ne correspondent pas' });

export default function ResetPasswordPage() {
  const token = queryToken(useLocation().search);
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema) });

  if (!token) {
    return (
      <>
        <Heading title="Lien invalide" />
        <Alert tone="error">Ce lien de réinitialisation est incomplet. <Link to="/forgot-password" className="underline">Demander un nouveau lien</Link>.</Alert>
      </>
    );
  }

  const onSubmit = async ({ password }) => {
    setError('');
    try {
      await api.post('/auth/reset-password', { token, password });
      navigate('/login', { replace: true, state: { notice: 'Mot de passe modifié. Vous pouvez vous connecter.' } });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <Heading title="Nouveau mot de passe">Choisissez un nouveau mot de passe. Vos autres sessions seront fermées.</Heading>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Alert tone="error">{error}</Alert>
        <Input label="Nouveau mot de passe" type="password" autoComplete="new-password" hint={PASSWORD_HINT} error={errors.password?.message} {...register('password')} />
        <Input label="Confirmer" type="password" autoComplete="new-password" error={errors.confirm?.message} {...register('confirm')} />
        <Button type="submit" loading={isSubmitting} className="w-full">Enregistrer</Button>
      </form>
    </>
  );
}
