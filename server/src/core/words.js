// Montant en toutes lettres (« Arrêtée la présente facture à la somme de … »). Fonction PURE : elle ne fait que mettre en lettres
// le montant déjà calculé par le serveur (chaîne décimale, jamais recalculée). Entiers jusqu'à 999 999 999 999.
// Dinar tunisien : 1 dinar = 1 000 millimes (3 décimales). Autres devises : seulement si le montant tient en 2 décimales (sinon null).

// ---------- Français (orthographe rectifiée non utilisée : traits d'union « classiques » conservés)
const U = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const T = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

function below100(n, final) { // 0..99 ; final = le nombre termine le groupe (« quatre-vingts » prend son s)
  if (n < 20) return U[n];
  const t = Math.floor(n / 10); const u = n % 10;
  if (t === 7 || t === 9) { const base = t === 7 ? 'soixante' : 'quatre-vingt'; const r = 10 + u; return `${base}${t === 7 && u === 1 ? ' et ' : '-'}${U[r]}`; }
  if (t === 8) return u === 0 ? (final ? 'quatre-vingts' : 'quatre-vingt') : `quatre-vingt-${U[u]}`;
  if (u === 0) return T[t];
  return `${T[t]}${u === 1 ? ' et ' : '-'}${U[u]}`;
}
function below1000(n, final) { // 1..999
  const h = Math.floor(n / 100); const r = n % 100; const parts = [];
  if (h) parts.push(h === 1 ? 'cent' : `${U[h]} cent${r === 0 && final ? 's' : ''}`);
  if (r) parts.push(below100(r, final));
  return parts.join(' ');
}
export function frenchInteger(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('entier positif attendu');
  if (n === 0) return 'zéro';
  const scales = [[1e9, 'milliard'], [1e6, 'million']]; const out = []; let rest = n;
  for (const [v, name] of scales) {
    const q = Math.floor(rest / v); rest %= v;
    if (q) out.push(`${below1000(q, false)} ${name}${q > 1 ? 's' : ''}`);
  }
  const th = Math.floor(rest / 1000); rest %= 1000;
  if (th) out.push(th === 1 ? 'mille' : `${below1000(th, false)} mille`); // « mille » est invariable ; « deux cent mille » sans s
  if (rest) out.push(below1000(rest, true));
  return out.join(' ');
}

const FR_NAMES = { TND: ['dinar', 'millime'], EUR: ['euro', 'centime'], USD: ['dollar', 'cent'] };

// amount : chaîne décimale « 3052.750 ». Renvoie null si le montant ne peut pas être mis en lettres sans l'altérer.
export function amountInWords(amount, currency = 'TND', lang = 'fr') {
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,3}))?$/.exec(String(amount).trim());
  if (!m) return null;
  const whole = Number(m[2]); const frac = (m[3] ?? '').padEnd(3, '0');
  const dec = currency === 'TND' ? 3 : 2;
  if (dec === 2 && frac[2] !== '0') return null; // ex. EUR avec 3 décimales : on ne tronque pas, on s'abstient
  const sub = Number(frac.slice(0, dec) === '' ? 0 : frac.slice(0, dec)); const neg = m[1] === '-' && (whole > 0 || sub > 0);
  const names = FR_NAMES[currency] ?? [currency, 'millièmes'];
  const plural = (n, name) => `${name}${n > 1 && !/s$/.test(name) ? 's' : ''}`;
  const unit = `${frenchInteger(whole)} ${plural(whole, names[0])}`;
  if (sub === 0) return `${neg ? 'moins ' : ''}${unit}`;
  const subTxt = `${frenchInteger(sub)} ${plural(sub, names[1])}`;
  return `${neg ? 'moins ' : ''}${whole === 0 ? subTxt : `${unit} et ${subTxt}`}`;
}
