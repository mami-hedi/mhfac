import { Outlet } from 'react-router-dom';
import { ShieldCheck, FileText, Boxes } from 'lucide-react';
import Logo from '../components/Logo.jsx';

const POINTS = [
  { icon: FileText, text: 'Devis, factures et avoirs pour les entreprises tunisiennes' },
  { icon: Boxes, text: 'Achats, stock, paiements et trésorerie au même endroit' },
  { icon: ShieldCheck, text: 'Données isolées par entreprise, rôles et permissions' },
];

export default function AuthLayout() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_minmax(420px,520px)]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-brand-700 via-brand-600 to-brand-800 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-2.5">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-white/15 ring-1 ring-white/25"><FileText size={24} aria-hidden /></span>
          <span className="text-2xl tracking-tight"><b className="font-extrabold">MH</b><span className="font-light">Fac</span></span>
        </div>
        <div>
          <h2 className="max-w-md text-3xl font-semibold leading-tight">La facturation et la gestion commerciale, pensées pour la Tunisie.</h2>
          <ul className="mt-8 space-y-4">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-brand-100"><Icon size={20} className="mt-0.5 shrink-0" aria-hidden />{text}</li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-brand-200">© MH Digital Solution</p>
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/5" aria-hidden />
        <div className="pointer-events-none absolute -bottom-32 right-10 h-80 w-80 rounded-full bg-white/5" aria-hidden />
      </aside>
      <main className="flex items-center justify-center bg-white px-5 py-10 sm:px-10">
        <div className="w-full max-w-sm">
          <Logo size="lg" subtitle className="mb-8 lg:hidden" />
          <Outlet />
        </div>
      </main>
    </div>
  );
}
