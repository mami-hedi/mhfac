// CSV minimal (RFC 4180) : guillemets, retours a la ligne dans les champs, delimiteur detecte (; , tab) -> Excel FR.
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (inQ) throw new Error('Guillemet non fermé');
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return { delimiter: delim, headers: rows[0] ?? [], rows: rows.slice(1) };
}

// Export : protection contre l'injection de formule (=, +, -, @) a l'ouverture dans Excel.
const safe = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(,\d+)?$/.test(s)) s = `'${s}`; // un nombre négatif (« -5,000 ») reste un nombre
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (headers, rows) => `﻿${[headers, ...rows].map((r) => r.map(safe).join(';')).join('\r\n')}\r\n`;
