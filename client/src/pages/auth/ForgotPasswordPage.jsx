import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Input } from '../../components/ui/index.jsx';
import { Heading } from './parts.jsx';

const schema = z.object({ email: z.string().trim().min(1, 'E-mail requis').email('E-mail invalide') });

export default function ForgotPasswordPage() {
  const [state, setState] = useState({ sent: false, error: '' });
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema) });

  const onSubmit = async (values) => {
    try {
      await api.post('/auth/forgot-password', values);
      setState({ sent: true, error: '' });
    } catch (e) {
      setState({ sent: false, error: errorMessage(e) });
    }
  };

  return (
    <>
      <Heading title="Mot de passe oublié">Saisissez votre adresse e-mail : nous vous enverrons un lien de réinitialisation.</Heading>
      {state.sent ? (
        <Alert tone="success">Si un compte existe pour cette adresse, un e-mail vient d'être envoyé (lien valable 1 heure).</Alert>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <Alert tone="error">{state.error}</Alert>
          <Input label="Adresse e-mail" type="email" autoComplete="email" error={errors.email?.message} {...register('email')} />
          <Button type="submit" loading={isSubmitting} className="w-full">Envoyer le lien</Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link to="/login" className="text-brand-600 hover:underline">Retour à la connexion</Link></p>
    </>
  );
}
