// Arithmétique décimale exacte (millimes, BigInt) pour les totaux de rapports : jamais de flottant.
export const sc = (v) => { const raw = String(v ?? '0').trim(); const neg = raw.startsWith('-'); const [i, f = ''] = raw.replace('-', '').split('.'); const n = BigInt((i || '0') + f.padEnd(3, '0').slice(0, 3)); return neg ? -n : n; };
export const fmt3 = (n) => { const neg = n < 0n; const t = (neg ? -n : n).toString().padStart(4, '0'); return `${neg ? '-' : ''}${t.slice(0, -3)}.${t.slice(-3)}`; };
export const sumCol = (rows, key) => fmt3(rows.reduce((s, r) => s + sc(r[key]), 0n));
export const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
export const MAX_ROWS = 20000;
