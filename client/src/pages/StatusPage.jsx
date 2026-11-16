import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { getHealth } from '../services/api.js';

export default function StatusPage() {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    getHealth()
      .then((data) => setState({ data }))
      .catch((err) => setState({ error: err.response?.data?.error?.message ?? err.message }));
  }, []);

  const ok = state.data?.status === 'ok';
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-3xl font-bold text-brand-700">MHFac</h1>
        <p className="text-sm text-slate-500">MH Digital Solution · Phase 2 : verification technique</p>
      </div>
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-live="polite">
        {state.loading && (
          <p className="flex items-center gap-2 text-slate-600"><Loader2 className="animate-spin" size={18} /> Connexion à l'API…</p>
        )}
        {state.error && (
          <p className="flex items-center gap-2 text-red-600"><XCircle size={18} /> API injoignable : {state.error}</p>
        )}
        {state.data && (
          <ul className="space-y-2 text-sm">
            <li className={`flex items-center gap-2 ${ok ? 'text-green-700' : 'text-orange-600'}`}>
              {ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />} API : {state.data.status}
            </li>
            <li className="text-slate-600">Base de données : {state.data.db}</li>
            <li className="text-slate-400">Heure serveur : {state.data.time}</li>
          </ul>
        )}
      </section>
    </main>
  );
}
