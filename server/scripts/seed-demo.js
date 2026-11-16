// Jeu de données de DÉMONSTRATION (fictif) : crée une entreprise « Société Démo » via l'API publique.
// Aucune donnée n'est insérée directement en base : tout passe par les mêmes règles que l'application
// (calculs serveur, numérotation, stock, paiements). À lancer API démarrée :
//   npm run seed-demo                      (API sur http://127.0.0.1:<PORT>/api/v1)
//   DEMO_API_URL=https://... npm run seed-demo
// Variables : DEMO_EMAIL (défaut demo@mhfac.demo), DEMO_PASSWORD (défaut : généré et affiché).
import crypto from 'node:crypto';

if (process.env.NODE_ENV === 'production' && process.env.DEMO_FORCE !== '1') {
  console.error('Refus : NODE_ENV=production. Ne chargez pas de données fictives en production (DEMO_FORCE=1 pour forcer).');
  process.exit(1);
}
const base = process.env.DEMO_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}/api/v1`;
const email = process.env.DEMO_EMAIL ?? 'demo@mhfac.demo';
const password = process.env.DEMO_PASSWORD ?? `Demo-${crypto.randomBytes(6).toString('hex')}A1`;

let token = null;
async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? text}`);
  return json?.data;
}
const tunisToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const today = tunisToday();
const notFuture = (d) => (d > today ? today : d);

const reg = await fetch(`${base}/auth/register-company`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ companyName: 'Société Démo (données fictives)', fullName: 'Utilisateur Démo', email, password }),
});
const regJson = await reg.json();
if (reg.status !== 201) {
  console.error(`Impossible de créer l'entreprise démo (${reg.status}) : ${regJson?.error?.message ?? ''}`);
  console.error('Si le compte existe déjà, utilisez une autre adresse : DEMO_EMAIL=demo2@mhfac.demo npm run seed-demo');
  process.exit(1);
}
token = regJson.data.accessToken;

const taxes = await api('GET', '/tax-rates');
const tax19 = taxes.find((t) => t.rate === '19.00');
const tax7 = taxes.find((t) => t.rate === '7.00');
const wh = (await api('GET', '/stock/warehouses'))[0];

const clientNames = ['Atelier El Medina SARL', 'Boulangerie Les Délices', 'Cabinet Ben Salah & Associés', 'Garage Moderne Sfax', 'Librairie Ibn Khaldoun', 'Pharmacie Centrale Sousse'];
const clients = [];
for (const [i, name] of clientNames.entries()) clients.push(await api('POST', '/clients', { name, paymentTermsDays: i % 2 ? 30 : 15, email: `contact${i + 1}@example.invalid` }));
const suppliers = [];
for (const name of ['Grossiste Informatique Tunis', 'Papeterie Centrale', 'Énergie & Services Ariana']) suppliers.push(await api('POST', '/suppliers', { name }));

const prod = (p) => api('POST', '/products', p);
const clavier = await prod({ name: 'Clavier USB', sku: 'CLV-001', salePrice: '45.000', purchasePrice: '28.000', taxRateId: tax19.id, trackStock: true, stockAlertThreshold: '5' });
const souris = await prod({ name: 'Souris optique', sku: 'SOU-001', salePrice: '25.000', purchasePrice: '14.000', taxRateId: tax19.id, trackStock: true, stockAlertThreshold: '5' });
const ramette = await prod({ name: 'Ramette papier A4', sku: 'PAP-A4', salePrice: '12.500', purchasePrice: '8.000', taxRateId: tax7.id, trackStock: true });
const maintenance = await prod({ name: 'Maintenance mensuelle', type: 'service', salePrice: '300.000', taxRateId: tax19.id });
const formation = await prod({ name: 'Formation (demi-journée)', type: 'service', salePrice: '450.000', taxRateId: tax19.id });

await api('POST', '/stock/entries', {
  warehouseId: wh.id, date: addDays(today, -120),
  lines: [{ productId: clavier.id, quantity: 60, unitCost: '28.000' }, { productId: souris.id, quantity: 80, unitCost: '14.000' }, { productId: ramette.id, quantity: 200, unitCost: '8.000' }],
});

// Factures émises sur ~5 mois, dont une partie encaissée, partielle ou en retard.
const catalogue = [clavier, souris, ramette, maintenance, formation];
const sub = await api('GET', '/subscription');
const maxInvoices = sub.limits?.invoicesPerMonth ?? sub.plan?.limits?.invoicesPerMonth ?? null;
const target = maxInvoices == null ? 24 : Math.min(24, Math.max(0, maxInvoices));
if (target < 24) console.warn(`Plan « ${sub.plan?.name ?? '?'} » : limité à ${maxInvoices} factures/mois, seules ${target} factures seront créées. Pour une démo complète, lancez l'API avec un DEFAULT_PLAN_CODE sans limite basse (ex. pro ou business).`);
let n = 0;
const issued = [];
for (let m = 5; m >= 0; m--) {
  for (let k = 3; k >= 0; k--) {
    if (n >= target) break;
    const client = clients[(n + k) % clients.length];
    const issueDate = addDays(today, -m * 28 - k * 6);
    const lines = [0, 1].map((j) => ({ productId: catalogue[(n + j) % catalogue.length].id, quantity: 1 + ((n + j) % 4) }));
    const d = await api('POST', '/invoices', { clientId: client.id, issueDate, lines });
    issued.push({ client, inv: await api('POST', `/invoices/${d.id}/issue`) });
    n++;
  }
}
// Encaissements : 1 facture sur 2 soldée, 1 sur 5 en partie, le reste impayé (certaines échues).
for (const [i, { client, inv }] of issued.entries()) {
  if (i % 2 === 0) await api('POST', '/payments', { clientId: client.id, date: notFuture(addDays(inv.issueDate, 10)), method: i % 4 === 0 ? 'bank_transfer' : 'cash', allocations: [{ invoiceId: inv.id, amount: inv.netPayable }] });
  else if (i % 5 === 0) await api('POST', '/payments', { clientId: client.id, date: notFuture(addDays(inv.issueDate, 12)), method: 'cash', allocations: [{ invoiceId: inv.id, amount: '50.000' }] });
}

// Achats enregistrés.
for (const [i, sp] of suppliers.entries()) {
  const pi = await api('POST', '/purchase-invoices', { supplierId: sp.id, issueDate: addDays(today, -20 * (i + 1)), supplierRef: `DEMO-${i + 1}`, lines: [{ description: 'Achat de démonstration', quantity: 1, unitPrice: String(400 + i * 150), taxRateId: tax19.id }] });
  await api('POST', `/purchase-invoices/${pi.id}/record`);
}
await api('POST', '/treasury/accounts', { code: 'CAISSE', name: 'Caisse principale', type: 'cash', openingBalance: '500.000' });
await api('POST', '/quotes', { clientId: clients[0].id, issueDate: today, lines: [{ productId: formation.id, quantity: 2 }] });

console.log('\n=== Données de démonstration créées (FICTIVES) ===');
console.log(`Entreprise : Société Démo (données fictives)\nE-mail     : ${email}\nMot de passe : ${password}`);
console.log(`${clients.length} clients, ${suppliers.length} fournisseurs, ${catalogue.length} articles, ${issued.length} factures émises, 3 achats, 1 devis.`);
console.log('Connectez-vous sur le client puis supprimez cette entreprise de test avant toute mise en production.');
