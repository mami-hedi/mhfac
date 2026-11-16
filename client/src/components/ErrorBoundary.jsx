import { Component } from 'react';

// Filet de sécurité : une erreur d'affichage inattendue ne doit jamais laisser une page blanche.
export default class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Erreur interface', error, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Une erreur est survenue</h1>
        <p className="text-sm text-slate-600">L'affichage de cette page a rencontré un problème. Vos données ne sont pas perdues : rechargez la page ou revenez à l'accueil.</p>
        <div className="flex gap-3">
          <button type="button" onClick={() => window.location.reload()} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Recharger la page</button>
          <button type="button" onClick={() => { window.location.href = '/'; }} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Accueil</button>
        </div>
      </div>
    );
  }
}
