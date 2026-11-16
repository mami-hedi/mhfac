import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Building2, ChevronDown, Gauge, Landmark, Tags, X } from 'lucide-react';
import Logo from '../components/Logo.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { visibleNav } from '../config/nav.js';
import { cn } from '../utils/format.js';

const linkCls = ({ isActive }) => cn(
  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition',
  isActive ? 'bg-brand-50 font-medium text-brand-700 shadow-[inset_3px_0_0_var(--color-brand-600)]' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
);

function Group({ item }) {
  const { pathname } = useLocation();
  const active = item.children.some((c) => pathname.startsWith(c.path));
  const [open, setOpen] = useState(active);
  useEffect(() => { if (active) setOpen(true); }, [active]);
  const Icon = item.icon;
  return (
    <div>
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className={cn('flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-slate-100', active ? 'font-medium text-slate-900' : 'text-slate-600')}>
        <Icon size={18} aria-hidden />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDown size={16} className={cn('transition', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="ml-[18px] mt-0.5 space-y-0.5 border-l border-slate-200 pl-2.5">
          {item.children.map((c) => (
            <NavLink key={c.path} to={c.path} className={linkCls}>{c.label}</NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ open, onClose }) {
  const { can, user } = useAuth();
  const nav = visibleNav(can);
  if (user?.isPlatformAdmin) nav.push({ label: 'Plateforme', items: [
    { label: 'Vue d\'ensemble', path: '/platform', icon: Gauge },
    { label: 'Entreprises', path: '/platform/companies', icon: Building2 },
    { label: 'Offres', path: '/platform/plans', icon: Tags },
    { label: 'Paiements', path: '/platform/payments', icon: Landmark },
  ] });
  const { pathname } = useLocation();
  useEffect(() => { onClose(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={onClose} aria-hidden />}
      <aside className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-slate-200 bg-white transition-transform lg:w-64 lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )} aria-label="Navigation principale">
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-slate-100 px-4">
          <Logo subtitle />
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Fermer le menu"><X size={20} /></button>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {nav.map((g) => (
            <div key={g.label}>
              <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.label}</p>
              <div className="space-y-0.5">
                {g.items.map((i) =>
                  i.children ? <Group key={i.label} item={i} /> : (
                    <NavLink key={i.path} to={i.path} end={['/', '/settings', '/platform'].includes(i.path)} className={linkCls}>
                      <i.icon size={18} aria-hidden /> {i.label}
                    </NavLink>
                  ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
