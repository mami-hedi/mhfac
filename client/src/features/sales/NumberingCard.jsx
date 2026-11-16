// « Numérotation des documents » : pour chaque type de document, l'utilisateur choisit librement l'abréviation (FAC, F, BC, BL…),
// le séparateur, la présence de l'année, la remise à zéro annuelle, le nombre de chiffres et le prochain numéro.
// Les numéros déjà attribués ne changent jamais. Les règles (préfixe unique, compteur qui ne diminue pas) sont contrôlées par le serveur.
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Card, Spinner } from '../../components/ui/index.jsx';

const SEPS = [['-', 'tiret  -'], ['/', 'barre  /'], ['.', 'point  .'], ['_', 'souligné  _'], ['', 'aucun']];
const cell = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:bg-slate-100';
// Même règle que le serveur, pour l'exemple en direct uniquement (le numéro réel est toujours attribué par le serveur).
const example = (r, year) => `${r.prefix || '…'}${r.separator}${r.includeYear ? `${year}${r.separator}` : ''}${String(r.nextNumber || 1).padStart(Number(r.width) || 5, '0')}`;

export default function NumberingCard({ editable }) {
  const [data, setData] = useState(null); const [rows, setRows] = useState([]); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const load = async () => { const r = await api.get('/companies/current/numbering'); setData(r.data.data); setRows(r.data.data.items.map((i) => ({ ...i }))); };
  useEffect(() => { load().catch((e) => setMsg({ tone: 'error', text: errorMessage(e) })); }, []);

  const base = useMemo(() => Object.fromEntries((data?.items ?? []).map((i) => [i.docType, i])), [data]);
  const changed = rows.filter((r) => { const b = base[r.docType]; return b && (r.prefix.toUpperCase() !== b.prefix || r.separator !== b.separator || r.includeYear !== b.includeYear || r.yearlyReset !== b.yearlyReset || Number(r.width) !== b.width || Number(r.nextNumber) !== b.nextNumber); });
  const set = (docType, patch) => setRows((rs) => rs.map((r) => (r.docType === docType ? { ...r, ...patch } : r)));
  // préfixes en double repérés tout de suite (le serveur refuse de toute façon)
  const dupes = useMemo(() => { const m = {}; rows.forEach((r) => { const k = r.prefix.trim().toUpperCase(); if (k) (m[k] ??= []).push(r.docType); }); return new Set(Object.values(m).filter((v) => v.length > 1).flat()); }, [rows]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const items = changed.map((r) => { const b = base[r.docType]; return { docType: r.docType, prefix: r.prefix.trim(), separator: r.separator, includeYear: r.includeYear, yearlyReset: r.yearlyReset, width: Number(r.width), nextNumber: Number(r.nextNumber) !== b.nextNumber ? Number(r.nextNumber) : null }; });
      const r = await api.put('/companies/current/numbering', { items });
      setData(r.data.data); setRows(r.data.data.items.map((i) => ({ ...i }))); setMsg({ tone: 'success', text: 'Numérotation enregistrée. Elle s\'applique aux prochains documents ; les numéros déjà attribués ne changent pas.' });
    } catch (e) { setMsg({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(false); }
  };
  const reset = (r) => set(r.docType, { prefix: r.defaultPrefix, separator: '-', includeYear: true, yearlyReset: true, width: 5 });

  if (!data) return <Card className="p-5">{msg ? <Alert tone="error">{msg.text}</Alert> : <Spinner />}</Card>;
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-slate-900">Numérotation des documents</h2>
      <p className="mb-3 text-sm text-slate-500">Choisissez pour chaque type de document son abréviation et son format (par exemple <span className="font-mono">FAC-2026-00001</span>, <span className="font-mono">F/2026/001</span> ou <span className="font-mono">BL0007</span>). Chaque abréviation doit être différente. Les numéros déjà attribués ne changent jamais ; le compteur ne peut qu'augmenter.</p>
      {msg && <div className="mb-3"><Alert tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert></div>}
      {groups.map((g) => (
        <div key={g} className="mb-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-800">{g}</h3>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600"><tr>
                <th className="p-2 font-medium">Document</th><th className="p-2 font-medium">Abréviation</th><th className="p-2 font-medium">Séparateur</th><th className="p-2 font-medium">Année dans le numéro</th>
                <th className="p-2 font-medium">Remise à zéro chaque année</th><th className="p-2 font-medium">Chiffres</th><th className="p-2 font-medium">Prochain n°</th><th className="p-2 font-medium">Exemple</th></tr></thead>
              <tbody>
                {rows.filter((r) => r.group === g).map((r) => {
                  const b = base[r.docType]; const bad = dupes.has(r.docType) || !/^[A-Za-z0-9]{1,10}$/.test(r.prefix.trim());
                  return (
                    <tr key={r.docType} className="border-t border-slate-100">
                      <td className="p-2 font-medium text-slate-800">{r.label}</td>
                      <td className="p-2"><input aria-label={`Abréviation — ${r.label}`} aria-invalid={bad} disabled={!editable} maxLength={10} value={r.prefix} onChange={(e) => set(r.docType, { prefix: e.target.value.toUpperCase() })} className={`${cell} w-24 font-mono ${bad ? 'border-red-500 bg-red-50' : ''}`} />
                        {dupes.has(r.docType) && <span className="mt-0.5 block text-xs text-red-600">Déjà utilisée</span>}</td>
                      <td className="p-2"><select aria-label={`Séparateur — ${r.label}`} disabled={!editable} value={r.separator} onChange={(e) => set(r.docType, { separator: e.target.value })} className={cell}>{SEPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                      <td className="p-2"><input type="checkbox" aria-label={`Année dans le numéro — ${r.label}`} disabled={!editable || r.yearlyReset} checked={r.includeYear} onChange={(e) => set(r.docType, { includeYear: e.target.checked })} /></td>
                      <td className="p-2"><input type="checkbox" aria-label={`Remise à zéro annuelle — ${r.label}`} disabled={!editable} checked={r.yearlyReset} onChange={(e) => set(r.docType, e.target.checked ? { yearlyReset: true, includeYear: true } : { yearlyReset: false })} /></td>
                      <td className="p-2"><select aria-label={`Nombre de chiffres — ${r.label}`} disabled={!editable} value={r.width} onChange={(e) => set(r.docType, { width: Number(e.target.value) })} className={cell}>{[3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}</select></td>
                      <td className="p-2"><input type="number" aria-label={`Prochain numéro — ${r.label}`} disabled={!editable} min={b.nextNumber} value={r.nextNumber} onChange={(e) => set(r.docType, { nextNumber: e.target.value === '' ? '' : Number(e.target.value) })} className={`${cell} w-24`} />
                        {Number(r.nextNumber) < b.nextNumber && <span className="mt-0.5 block text-xs text-red-600">Min. {b.nextNumber}</span>}</td>
                      <td className="p-2 font-mono text-xs text-slate-700">{example(r, data.year)}</td>
                      <td className="p-2">{editable && <button type="button" onClick={() => reset(r)} className="text-xs text-brand-700 underline">Défaut</button>}</td>
                    </tr>);
                })}
              </tbody>
            </table>
          </div>
        </div>))}
      <p className="mb-3 text-xs text-slate-500">« Remise à zéro chaque année » : la numérotation repart à 1 au 1er janvier (l'année figure alors dans le numéro). Sans remise à zéro, la numérotation est continue. En changeant ce mode, le compteur repart au plus haut numéro déjà utilisé : aucun doublon n'est possible. Cet exemple est indicatif : le numéro réel est attribué par le serveur au moment de l'émission ou de la validation.</p>
      {editable && <Button type="button" loading={busy} disabled={!changed.length || dupes.size > 0 || busy} onClick={save}>Enregistrer la numérotation{changed.length ? ` (${changed.length})` : ''}</Button>}
    </Card>
  );
}
