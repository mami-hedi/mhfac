import { forwardRef, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Info, Loader2, X } from 'lucide-react';
import { cn } from '../../utils/format.js';

const BTN = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-brand-600',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};
export function Button({ variant = 'primary', loading, className, children, ...props }) {
  return (
    <button
      {...props}
      disabled={loading || props.disabled}
      className={cn('inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60', BTN[variant], className)}
    >
      {loading && <Loader2 className="animate-spin" size={16} aria-hidden />}
      {children}
    </button>
  );
}

// Champ de saisie. Un champ type="password" reçoit automatiquement l'œil « afficher / masquer » (connexion, inscription,
// réinitialisation, invitation, changement de mot de passe) ; le mot de passe n'est jamais affiché par défaut.
export const Input = forwardRef(function Input({ label, error, hint, className, id, type, ...props }, ref) {
  const inputId = id ?? props.name;
  const isPassword = type === 'password';
  const [shown, setShown] = useState(false);
  const field = (
    <input
      ref={ref} id={inputId} type={isPassword && shown ? 'text' : type} aria-invalid={!!error} aria-describedby={error ? `${inputId}-err` : undefined}
      className={cn('block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25 disabled:bg-slate-100', error ? 'border-red-400' : 'border-slate-300', isPassword && 'pr-10 rtl:pl-10 rtl:pr-3')}
      {...(isPassword ? { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } : {})}
      {...props}
    />
  );
  return (
    <div className={className}>
      {label && <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-slate-700">{label}</label>}
      {isPassword ? (
        <div className="relative">
          {field}
          <button
            type="button" onClick={() => setShown((v) => !v)} aria-label={shown ? 'Masquer le mot de passe' : 'Afficher le mot de passe'} aria-pressed={shown} title={shown ? 'Masquer' : 'Afficher'}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 rtl:left-2 rtl:right-auto"
          >
            {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
          </button>
        </div>
      ) : field}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && <p id={`${inputId}-err`} className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
});

export const Select = forwardRef(function Select({ label, error, className, children, id, ...props }, ref) {
  const selectId = id ?? props.name;
  return (
    <div className={className}>
      {label && <label htmlFor={selectId} className="mb-1 block text-sm font-medium text-slate-700">{label}</label>}
      <select ref={ref} id={selectId} className={cn('block w-full rounded-md border bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25 disabled:bg-slate-100', error ? 'border-red-400' : 'border-slate-300')} {...props}>
        {children}
      </select>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
});

export const Card = ({ className, children }) => (
  <section className={cn('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>{children}</section>
);

const TONES = {
  neutral: 'bg-slate-100 text-slate-700', blue: 'bg-brand-50 text-brand-700', green: 'bg-green-50 text-green-700',
  orange: 'bg-orange-50 text-orange-700', red: 'bg-red-50 text-red-700',
};
export const Badge = ({ tone = 'neutral', children }) => (
  <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', TONES[tone])}>{children}</span>
);

const ALERTS = {
  error: ['border-red-200 bg-red-50 text-red-800', AlertCircle],
  success: ['border-green-200 bg-green-50 text-green-800', CheckCircle2],
  info: ['border-brand-100 bg-brand-50 text-brand-800', Info],
};
export function Alert({ tone = 'info', children, onClose }) {
  if (!children) return null;
  const [cls, Icon] = ALERTS[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', cls)}>
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="flex-1">{children}</div>
      {onClose && <button onClick={onClose} aria-label="Fermer" className="opacity-60 hover:opacity-100"><X size={14} /></button>}
    </div>
  );
}

export const Spinner = ({ label = 'Chargement…' }) => (
  <div className="flex items-center justify-center gap-2 py-16 text-slate-500" role="status">
    <Loader2 className="animate-spin" size={18} aria-hidden /> {label}
  </div>
);

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {Icon && <div className="rounded-full bg-brand-50 p-3 text-brand-600"><Icon size={26} aria-hidden /></div>}
      <p className="font-medium text-slate-800">{title}</p>
      {children && <p className="max-w-md text-sm text-slate-500">{children}</p>}
      {action}
    </div>
  );
}

export function Modal({ title, onClose, children, size = 'md' }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cn('max-h-[92vh] w-full overflow-y-auto rounded-t-xl bg-white p-5 shadow-xl sm:rounded-xl', size === 'lg' ? 'max-w-2xl' : 'max-w-md')}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-slate-500 hover:bg-slate-100"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const PageHeader = ({ title, subtitle, actions }) => (
  <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
    </div>
    {actions}
  </div>
);
