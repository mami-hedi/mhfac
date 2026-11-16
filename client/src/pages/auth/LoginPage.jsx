import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { errorMessage } from '../../services/api.js';
import { Alert, Button, Input } from '../../components/ui/index.jsx';
import { Heading } from './parts.jsx';

const schema = z.object({
  email: z.string().trim().min(1, 'E-mail requis').email('E-mail invalide'),
  password: z.string().min(1, 'Mot de passe requis'),
});

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema) });

  const onSubmit = async (values) => {
    setError('');
    try {
      await login(values);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <Heading title="Connexion">Accédez à votre espace MHFac.</Heading>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {location.state?.notice && <Alert tone="success">{location.state.notice}</Alert>}
        <Alert tone="error">{error}</Alert>
        <Input label="Adresse e-mail" type="email" autoComplete="email" error={errors.email?.message} {...register('email')} />
        <Input label="Mot de passe" type="password" autoComplete="current-password" error={errors.password?.message} {...register('password')} />
        <div className="text-right text-sm"><Link to="/forgot-password" className="text-brand-600 hover:underline">Mot de passe oublié ?</Link></div>
        <Button type="submit" loading={isSubmitting} className="w-full">Se connecter</Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        Pas encore de compte ? <Link to="/register" className="font-medium text-brand-600 hover:underline">Créer mon entreprise</Link>
      </p>
    </>
  );
}
