// Graphiques SVG légers (sans dépendance). Les valeurs arrivent du serveur en chaînes décimales ; la conversion en nombre ne sert qu'au dessin.
const COLORS = ['#1d4ed8', '#0891b2', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#64748b', '#0d9488'];
const n = (v) => Number(v) || 0;
const short = (v) => { const x = Math.abs(n(v)); return x >= 1e6 ? `${(n(v) / 1e6).toFixed(1)} M` : x >= 1e3 ? `${(n(v) / 1e3).toFixed(1)} k` : String(Math.round(n(v))); };
export const money = (v, cur = 'TND') => `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(n(v)).replace(/[  ]/g, ' ')} ${cur}`;

export function BarChart({ data, height = 180, cur = 'TND', label = 'Graphique en barres' }) {
  if (!data?.length || data.every((d) => n(d.value) === 0)) return <p className="py-8 text-center text-sm text-slate-400">Aucune donnée sur la période.</p>;
  const max = Math.max(...data.map((d) => n(d.value)), 1); const W = 600; const pad = 24; const bw = (W - pad * 2) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${height + 28}`} role="img" aria-label={label} className="h-auto w-full">
      <line x1={pad} x2={W - pad} y1={height} y2={height} stroke="#cbd5e1" />
      {data.map((d, i) => { const h = (Math.max(n(d.value), 0) / max) * (height - 18); const x = pad + i * bw + bw * 0.15;
        return (<g key={d.label}><title>{`${d.label} : ${money(d.value, cur)}`}</title>
          <rect x={x} y={height - h} width={bw * 0.7} height={h} rx="3" fill="#1d4ed8" />
          {h > 0 && <text x={x + bw * 0.35} y={height - h - 4} textAnchor="middle" fontSize="9" fill="#475569">{short(d.value)}</text>}
          <text x={x + bw * 0.35} y={height + 14} textAnchor="middle" fontSize="9" fill="#64748b">{d.label.length > 7 ? d.label.slice(2) : d.label}</text></g>); })}
    </svg>
  );
}

export function HBars({ data, cur = 'TND' }) {
  if (!data?.length) return <p className="py-8 text-center text-sm text-slate-400">Aucune donnée sur la période.</p>;
  const max = Math.max(...data.map((d) => n(d.value)), 1);
  return (
    <ul className="space-y-2">{data.map((d, i) => (
      <li key={d.label} className="text-sm"><div className="mb-0.5 flex justify-between gap-2"><span className="truncate">{d.label}</span><span className="shrink-0 tabular-nums text-slate-600">{money(d.value, cur)}</span></div>
        <div className="h-2 overflow-hidden rounded bg-slate-100"><div className="h-2 rounded" style={{ width: `${(n(d.value) / max) * 100}%`, background: COLORS[i % COLORS.length] }} /></div></li>))}</ul>
  );
}

export function Donut({ data, cur = 'TND', label = 'Répartition' }) {
  const total = data.reduce((s, d) => s + Math.max(n(d.value), 0), 0);
  if (total === 0) return <p className="py-8 text-center text-sm text-slate-400">Aucune donnée sur la période.</p>;
  const R = 52; const C = 2 * Math.PI * R; let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 140 140" role="img" aria-label={label} className="h-32 w-32 shrink-0 -rotate-90">
        {data.map((d, i) => { const len = (Math.max(n(d.value), 0) / total) * C; const el = <circle key={d.label} cx="70" cy="70" r={R} fill="none" stroke={['#16a34a', '#dc2626', '#d97706', '#64748b'][i % 4]} strokeWidth="22" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc}><title>{`${d.label} : ${money(d.value, cur)}`}</title></circle>; acc += len; return el; })}
      </svg>
      <ul className="space-y-1 text-sm">{data.map((d, i) => <li key={d.label} className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: ['#16a34a', '#dc2626', '#d97706', '#64748b'][i % 4] }} />{d.label} : <strong className="tabular-nums">{money(d.value, cur)}</strong> <span className="text-slate-400">({Math.round((n(d.value) / total) * 100)} %)</span></li>)}</ul>
    </div>
  );
}
