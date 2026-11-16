import { FileCheck2 } from 'lucide-react';
import { cn } from '../utils/format.js';

// Identité MHFac : pastille bleue + mot-symbole « MH » (gras) « Fac » (léger), signature MH Digital Solution.
export default function Logo({ className, size = 'md', subtitle = false }) {
  const big = size === 'lg';
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span className={cn('grid place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm', big ? 'h-11 w-11' : 'h-9 w-9')}>
        <FileCheck2 size={big ? 24 : 20} aria-hidden />
      </span>
      <span className="leading-none">
        <span className={cn('block tracking-tight text-slate-900', big ? 'text-2xl' : 'text-xl')}>
          <b className="font-extrabold">MH</b><span className="font-light text-brand-600">Fac</span>
        </span>
        {subtitle && <span className="mt-1 block text-[11px] uppercase tracking-wider text-slate-400">MH Digital Solution</span>}
      </span>
    </div>
  );
}
