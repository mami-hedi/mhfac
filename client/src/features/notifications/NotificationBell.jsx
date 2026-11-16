// Cloche de l'en-tête : compteur de non lues (rafraîchi chaque minute), 6 dernières, « tout marquer comme lu ».
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api } from '../../services/api.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { cn } from '../../utils/format.js';
import { SEVERITY_DOT, timeAgo } from './common.js';

export default function NotificationBell() {
  const navigate = useNavigate(); const ref = useRef(null);
  const [open, setOpen] = useState(false); const [data, setData] = useState({ unread: 0, latest: [] }); const [failed, setFailed] = useState(false);
  useClickOutside(ref, () => setOpen(false), open);
  const load = useCallback(() => api.get('/notifications/summary').then((r) => { setData(r.data.data); setFailed(false); }).catch(() => setFailed(true)), []);
  useEffect(() => {
    load(); const t = setInterval(load, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);
  const openItem = async (n) => {
    setOpen(false);
    if (!n.read) await api.post(`/notifications/${n.id}/read`).catch(() => {});
    load(); if (n.link) navigate(n.link);
  };
  const readAll = async () => { await api.post('/notifications/read-all').catch(() => {}); load(); };
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={data.unread ? `Notifications : ${data.unread} non lue${data.unread > 1 ? 's' : ''}` : 'Notifications'}
        className="relative flex items-center rounded-md p-2 text-slate-600 hover:bg-slate-100">
        <Bell size={18} />
        {data.unread > 0 && <span data-testid="notif-count" className="absolute -right-0.5 -top-0.5 grid min-h-[16px] min-w-[16px] place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-1 w-80 max-w-[92vw] rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <p className="text-sm font-semibold text-slate-900">Notifications</p>
            {data.unread > 0 && <button onClick={readAll} className="text-xs font-medium text-brand-700 hover:underline">Tout marquer comme lu</button>}
          </div>
          {failed && <p className="px-3 py-2 text-xs text-amber-700">Mise à jour impossible pour le moment.</p>}
          {data.latest.length === 0 ? <p className="px-3 py-8 text-center text-sm text-slate-500">Aucune notification</p> : (
            <ul className="max-h-96 overflow-y-auto">{data.latest.map((n) => (
              <li key={n.id}>
                <button role="menuitem" onClick={() => openItem(n)} className={cn('flex w-full gap-2.5 px-3 py-2.5 text-left hover:bg-slate-50', !n.read && 'bg-brand-50/50')}>
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-slate-200' : SEVERITY_DOT[n.severity])} aria-hidden />
                  <span className="min-w-0 flex-1"><span className={cn('block text-sm text-slate-900', !n.read && 'font-semibold')}>{n.title}</span>
                    {n.body && <span className="block truncate text-xs text-slate-500">{n.body}</span>}
                    <span className="block text-[11px] text-slate-400">{timeAgo(n.createdAt)}</span></span>
                </button>
              </li>))}</ul>
          )}
          <div className="grid grid-cols-2 border-t border-slate-100 text-center text-xs font-medium">
            <button onClick={() => { setOpen(false); navigate('/notifications'); }} className="px-3 py-2 text-brand-700 hover:bg-slate-50">Voir tout</button>
            <button onClick={() => { setOpen(false); navigate('/notifications?tab=preferences'); }} className="border-l border-slate-100 px-3 py-2 text-slate-600 hover:bg-slate-50">Préférences</button>
          </div>
        </div>
      )}
    </div>
  );
}
