import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Spinner } from '../../components/ui/index.jsx';
import { Heading, queryToken } from './parts.jsx';

// Le lien est a usage unique : on partage la promesse par jeton pour que le double rendu de React (mode dev) ne le consomme pas deux fois.
const attempts = new Map();
const verify = (token) => {
  if (!attempts.has(token)) attempts.set(token, api.post('/auth/verify-email', { token }));
  return attempts.get(token);
};

export default function VerifyEmailPage() {
  const token = queryToken(useLocation().search);
  const [state, setState] = useState({ status: token ? 'loading' : 'error', message: token ? '' : 'Lien incomplet.' });

  useEffect(() => {
    if (!token) return;
    verify(token)
      .then(() => setState({ status: 'ok', message: '' }))
      .catch((e) => setState({ status: 'error', message: errorMessage(e) }));
  }, [token]);

  return (
    <>
      <Heading title="Vérification de l'adresse e-mail" />
      {state.status === 'loading' && <Spinner label="Vérification…" />}
      {state.status === 'ok' && <Alert tone="success">Votre adresse e-mail est confirmée.</Alert>}
      {state.status === 'error' && <Alert tone="error">{state.message}</Alert>}
      <p className="mt-6 text-center text-sm"><Link to="/" className="text-brand-600 hover:underline">Aller à MHFac</Link></p>
    </>
  );
}
