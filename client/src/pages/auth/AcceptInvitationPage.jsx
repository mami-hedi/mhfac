import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { errorMessage } from '../../services/api.js';
import { Alert, Button, Input } from '../../components/ui/index.jsx';
import { Heading, queryToken } from './parts.jsx';

const schema = z.object({ fullName: z.string().trim().max(190).optional(), password: z.string().min(1, 'Mot de passe requis').max(128) });

export default function AcceptInvitationPage() {
  const token = queryToken(useLocation().search);
  const { acceptInvitation } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema) });

  if (!token) {
    return (<><Heading title="Invitation invalide" /><Alert tone="error">Ce lien d'invitation est incomplet.</Alert></>);
  }

  const onSubmit = async ({ fullName, password }) => {
    setError('');
    try {
      await acceptInvitation({ token, password, ...(fullName ? { fullName } : {}) });
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <Heading title="Rejoindre l'entreprise">Vous avez été invité(e) sur MHFac. Créez votre compte, ou saisissez votre mot de passe si vous en avez déjà un.</Heading>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Alert tone="error">{error}</Alert>
        <Input label="Nom complet (nouveau compte uniquement)" autoComplete="name" error={errors.fullName?.message} {...register('fullName')} />
        <Input label="Mot de passe" type="password" autoComplete="new-password" hint="Nouveau compte : 10 caractères minimum, une lettre et un chiffre. Compte existant : votre mot de passe actuel." error={errors.password?.message} {...register('password')} />
        <Button type="submit" loading={isSubmitting} className="w-full">Accepter l'invitation</Button>
      </form>
      <p className="mt-6 text-center text-sm"><Link to="/login" className="text-brand-600 hover:underline">Retour à la connexion</Link></p>
    </>
  );
}
