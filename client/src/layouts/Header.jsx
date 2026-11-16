import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Building2, Check, ChevronDown, LogOut, Menu, Plus, Search, Settings, User } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';
import NotificationBell from '../features/notifications/NotificationBell.jsx';
import { QUICK_CREATE, flatPages } from '../config/nav.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { ROLE_LABELS, cn } from '../utils/format.js';

function Dropdown({ trigger, children, align = 'right', width = 'w-56', label }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={label}
        className="flex items-center gap-1.5 rounded-md p-2 text-slate-600 hover:bg-slate-100">{trigger}</button>
      {open && (
        <div role="menu" onClick={() => setOpen(false)}
          className={cn('absolute z-50 mt-1 rounded-lg border border-slate-200 bg-white p-1 shadow-lg', width, align === 'right' ? 'right-0' : 'left-0')}>
          {children}
        </div>
      )}
    </div>
  );
}
const Item = ({ icon: Icon, children, disabled, ...props }) => (
  <button role="menuitem" disabled={disabled} {...props}
    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent">
    {Icon && <Icon size={16} aria-hidden />}{children}
  </button>
);

// Recherche globale : trouve les pages accessibles (la recherche dans les données arrive avec les modules).
function GlobalSearch() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useClickOutside(ref, () => setQ(''), !!q);
  const pages = useMemo(() => flatPages().filter((p) => !p.perm || can(p.perm)), [can]);
  const results = q.trim()
    ? pages.filter((p) => `${p.group ?? ''} ${p.label}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)
    : [];
  const go = (path) => { setQ(''); navigate(path); };
  return (
    <div ref={ref} className="relative hidden max-w-md flex-1 md:block">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
      <input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Rechercher une page…" aria-label="Recherche globale"
        onKeyDown={(e) => e.key === 'Enter' && results[0] && go(results[0].path)}
        className="w-full rounded-md border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/25" />
      {q.trim() && (
        <ul className="absolute z-50 mt-1 w-full rounded-lg border border-slate-200 bg-white p-1 shadow-lg" role="listbox">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Aucune page trouvée</li>}
          {results.map((p) => (
            <li key={p.path}>
              <button onClick={() => go(p.path)} className="flex w-full flex-col rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100">
                <span className="font-medium text-slate-800">{p.label}</span>
                {p.group && <span className="text-xs text-slate-500">{p.group}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Header({ onMenu }) {
  const { user, company, role, memberships, can, logout, switchCompany } = useAuth();
  const navigate = useNavigate();
  const quick = QUICK_CREATE.filter((q) => can(q.perm));
  const initials = user.fullName.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-slate-200 bg-white/95 px-3 backdrop-blur sm:px-6">
      <button onClick={onMenu} className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Ouvrir le menu"><Menu size={20} /></button>
      <GlobalSearch />
      <div className="ml-auto flex items-center gap-1">
        {quick.length > 0 && (
          <Dropdown label="Création rapide" width="w-52" trigger={<><Plus size={16} /><span className="hidden text-sm font-medium sm:inline">Nouveau</span></>}>
            {quick.map((q) => <Item key={q.path} onClick={() => navigate(q.path)}>{q.label}</Item>)}
          </Dropdown>
        )}
        <Dropdown label="Entreprise" width="w-72" trigger={<><Building2 size={18} /><span className="hidden max-w-[10rem] truncate text-sm font-medium lg:inline">{company.name}</span><ChevronDown size={14} /></>}>
          <p className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Mes entreprises</p>
          {memberships.map((m) => (
            <Item key={m.companyId} onClick={() => m.companyId !== company.id && switchCompany(m.companyId).then(() => navigate('/'))}>
              <span className="flex-1 truncate">{m.name}</span>
              {m.companyId === company.id ? <Check size={16} className="text-brand-600" /> : <span className="text-xs text-slate-400">{ROLE_LABELS[m.role]}</span>}
            </Item>
          ))}
        </Dropdown>
        <NotificationBell />
        <Dropdown label="Profil" width="w-64" trigger={
          <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-600 text-xs font-semibold text-white">{initials}</span>}>
          <div className="border-b border-slate-100 px-2.5 pb-2 pt-1.5">
            <p className="truncate text-sm font-medium text-slate-900">{user.fullName}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
            <p className="mt-0.5 text-xs text-brand-700">{ROLE_LABELS[role]}</p>
          </div>
          <Item icon={User} onClick={() => navigate('/settings?tab=account')}>Mon compte</Item>
          <Item icon={Bell} onClick={() => navigate('/notifications')}>Mes notifications</Item>
          {can('settings.read') && <Item icon={Settings} onClick={() => navigate('/settings')}>Paramètres</Item>}
          <Item icon={LogOut} onClick={() => logout().then(() => navigate('/login'))}>Se déconnecter</Item>
        </Dropdown>
      </div>
    </header>
  );
}
