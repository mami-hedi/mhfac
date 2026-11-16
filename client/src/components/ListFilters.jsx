// Panneau de filtres commun à toutes les listes : champs principaux sur une ligne, filtres avancés dépliables, export CSV.
// Les filtres vivent dans l'adresse de la page (?status=issued&from=2026-01-01) : on peut recharger, revenir en arrière ou partager une vue.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, Download, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { api, errorMessage } from '../services/api.js';
import { Button } from './ui/index.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { downloadCsv } from '../features/masterdata/shared.jsx';

export const PAGE_SIZE = 15;
const box = 'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

// État des filtres = paramètres de l'adresse. `keys` : liste des filtres de la page.
export function useListFilters(keys) {
  const [sp, setSp] = useSearchParams();
  const f = useMemo(() => Object.fromEntries(keys.map((k) => [k, sp.get(k) ?? ''])), [sp]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const set = useCallback((patch) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v === '' || v == null) n.delete(k); else n.set(k, String(v)); }
    if (!('page' in patch)) n.delete('page'); // un filtre modifié ramène à la page 1
    return n;
  }, { replace: true }), [setSp]);
  const reset = useCallback(() => setSp({}, { replace: true }), [setSp]);
  const params = useMemo(() => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')), [f]);
  return { f, page, set, reset, params, active: Object.keys(params).length > 0 };
}

// Valeur « retardée » pour ne pas interroger le serveur à chaque frappe.
export function useDebouncedJson(value, ms = 350) {
  const json = JSON.stringify(value); const [d, setD] = useState(json);
  useEffect(() => { const t = setTimeout(() => setD(json), ms); return () => clearTimeout(t); }, [json, ms]);
  return d;
}

const Label = ({ id, children }) => <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">{children}</label>;

// Choix d'un client, fournisseur, produit ou projet : recherche côté serveur, l'adresse ne garde que l'identifiant.
function EntityPick({ id, value, onChange, path, label, placeholder, params = {} }) {
  const [open, setOpen] = useState(false); const [text, setText] = useState(''); const [items, setItems] = useState([]); const [name, setName] = useState(''); const ref = useRef();
  const nameOf = (x) => x.name ?? x.title ?? '';
  useEffect(() => { // retrouve le nom quand on arrive depuis une adresse partagée
    if (!value) { setName(''); return; }
    if (name) return;
    api.get(`${path}/${value}`).then((r) => setName(nameOf(r.data.data))).catch(() => setName('Sélection'));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => { api.get(path, { params: { q: text || undefined, limit: 10, ...params } }).then((r) => setItems(r.data.data)).catch(() => setItems([])); }, 250);
    return () => clearTimeout(t);
  }, [open, text, path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  return (
    <div ref={ref} className="relative">
      <Label id={id}>{label}</Label>
      {value ? (
        <div className={`${box} flex items-center justify-between gap-2`}><span className="truncate font-medium text-slate-800">{name || '…'}</span>
          <button type="button" aria-label={`Retirer le filtre ${label}`} onClick={() => { onChange(''); setName(''); }} className="text-slate-400 hover:text-slate-700"><X size={14} aria-hidden /></button></div>
      ) : (
        <button type="button" id={id} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} className={`${box} flex items-center justify-between text-left font-medium text-slate-700`}>
          <span className="truncate">{placeholder}</span><ChevronDown size={14} className="text-slate-400" aria-hidden />
        </button>
      )}
      {open && !value && (
        <div className="absolute z-20 mt-1 w-full min-w-[220px] rounded-md border border-slate-200 bg-white p-2 shadow-lg">
          <input autoFocus aria-label={`Rechercher ${label}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Rechercher…" className={box} />
          <ul role="listbox" className="mt-1 max-h-52 overflow-auto">
            {items.length === 0 ? <li className="px-3 py-2 text-sm text-slate-500">Aucun résultat</li> : items.map((x) => (
              <li key={x.id}><button type="button" role="option" onClick={() => { setName(nameOf(x)); onChange(x.id); setOpen(false); setText(''); }} className="block w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-slate-100">{nameOf(x)}</button></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Field({ spec, value, onChange }) {
  const id = `flt-${spec.key}`;
  if (spec.type === 'entity') return <EntityPick id={id} value={value} onChange={onChange} path={spec.path} label={spec.label} placeholder={spec.placeholder ?? `Sélectionner`} params={spec.params} />;
  if (spec.type === 'select') return <div><Label id={id}>{spec.label}</Label><select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={box}>{spec.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>;
  if (spec.type === 'date') return <div><Label id={id}>{spec.label}</Label><input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} className={box} /></div>;
  if (spec.type === 'money') return <div><Label id={id}>{spec.label}</Label><input id={id} inputMode="decimal" placeholder="0.000" value={value} onChange={(e) => onChange(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))} className={box} /></div>;
  return (
    <div><Label id={id}>{spec.label}</Label>
      <div className="relative"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" aria-hidden />
        <input id={id} value={value} placeholder={spec.placeholder ?? 'Rechercher des documents…'} onChange={(e) => onChange(e.target.value)} className={`${box} pl-9`} /></div>
    </div>
  );
}

// fields : [{ key, label, type: 'entity'|'select'|'date'|'money'|'search', advanced?: true, ... }]
export default function ListFilters({ fields, filters, exportPath, exportName, onError }) {
  const { f, set, reset, params, active } = filters;
  const { can } = useAuth(); const shown = fields.filter((x) => !x.perm || can(x.perm)); // un filtre n'apparaît que si l'utilisateur peut lire la liste concernée
  const main = shown.filter((x) => !x.advanced); const adv = shown.filter((x) => x.advanced);
  const advActive = adv.some((x) => f[x.key] !== '');
  const [open, setOpen] = useState(advActive); const [busy, setBusy] = useState(false);
  useEffect(() => { if (advActive) setOpen(true); }, [advActive]);
  const doExport = async () => {
    setBusy(true);
    try { await downloadCsv(exportPath, params, String(exportName).replace(/[\/]/g, '-')); } catch (e) { onError?.(errorMessage(e)); } finally { setBusy(false); }
  };
  const grid = 'grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]';
  return (
    <div className="border-b border-slate-200 p-4">
      <div className={grid}>{main.map((x) => <Field key={x.key} spec={x} value={f[x.key]} onChange={(v) => set({ [x.key]: v })} />)}</div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {adv.length > 0 && <Button type="button" variant="secondary" aria-expanded={open} aria-label="Filtres avancés" onClick={() => setOpen((o) => !o)}><SlidersHorizontal size={16} aria-hidden /> Filtres avancés {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}</Button>}
        {active && <Button type="button" variant="ghost" onClick={reset}><RotateCcw size={16} aria-hidden /> Réinitialiser</Button>}
        {exportPath && <Button type="button" variant="secondary" loading={busy} onClick={doExport}><Download size={16} aria-hidden /> Exporter CSV</Button>}
      </div>
      {open && adv.length > 0 && <div className={`${grid} mt-2`}>{adv.map((x) => <Field key={x.key} spec={x} value={f[x.key]} onChange={(v) => set({ [x.key]: v })} />)}</div>}
    </div>
  );
}
