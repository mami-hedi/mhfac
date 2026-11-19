import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, MailWarning, Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { api, errorMessage } from '../services/api.js';
import { Alert, Button, Card, PageHeader, Spinner } from '../components/ui/index.jsx';
import { BarChart, Donut, HBars, money } from '../components/Charts.jsx';

const KPI_LABELS = {
  revenue: "Chiffre d'affaires facturé", collected: 'Montants encaissés', unpaid: 'Factures impayées', overdue: 'Factures en retard',
  pending_quotes: 'Devis en attente', quote_conversion: 'Taux de conversion des devis', expenses: 'Dépenses enregistrées',
  client_balances: 'Soldes clients', supplier_balances: 'Soldes fournisseurs', treasury: 'Trésorerie enregistrée', low_stock: 'Produits sous le seuil de stock',
};

function ResendVerification() {
  const [state, setState] = useState({ busy: false, msg: '', error: false });
  const resend = async () => {
    setState({ busy: true, msg: '', error: false });
    try {
      const r = await api.post('/auth/resend-verification');
      setState({ busy: false, msg: r.data?.data?.alreadyVerified ? 'Votre adresse est déjà vérifiée : rechargez la page.' : 'E-mail envoyé. Vérifiez aussi vos courriers indésirables (spam).', error: false });
    } catch (e) { setState({ busy: false, msg: errorMessage(e), error: true }); }
  };
  return (
    <span className="flex flex-wrap items-center gap-3">
      <span className="flex items-center gap-2"><MailWarning size={16} aria-hidden /> Votre adresse e-mail n'est pas encore vérifiée : ouvrez le lien reçu par e-mail.</span>
      <Button variant="secondary" loading={state.busy} onClick={resend}>Renvoyer l'e-mail</Button>
      {state.msg && <span className={state.error ? 'text-red-700' : 'text-green-700'} role="status">{state.msg}</span>}
    </span>
  );
}

const iso = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(d);
const PRESETS = {
  month: ['Ce mois', () => { const t = new Date(); return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) }; }],
  quarter: ['Ce trimestre', () => { const t = new Date(); return { from: iso(new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1)), to: iso(t) }; }],
  year: ['Cette année', () => { const t = new Date(); return { from: iso(new Date(t.getFullYear(), 0, 1)), to: iso(t) }; }],
  last12: ['12 derniers mois', () => { const t = new Date(); return { from: iso(new Date(t.getFullYear() - 1, t.getMonth() + 1, 1)), to: iso(t) }; }],
};

const fr = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const DETAIL = {
  revenue: (v) => `${v.count} document(s) émis`, collected: (v) => `${v.count} règlement(s)`, unpaid: (v) => `${v.count} facture(s) ouverte(s)`, overdue: (v) => `${v.count} facture(s) échue(s)`,
  pending_quotes: () => 'envoyés, non expirés', quote_conversion: (v) => (v.count ? `${v.converted} converti(s) sur ${v.count} devis envoyés ou décidés` : 'aucun devis envoyé sur la période'),
  expenses: (v) => `${v.count} facture(s) d'achat`, client_balances: (v) => `${v.count} client(s) débiteur(s)`, supplier_balances: (v) => `${v.count} fournisseur(s) à payer`, treasury: (v) => `${v.count} compte(s) actif(s)`, low_stock: () => 'au seuil ou en dessous',
};
export default function DashboardPage() {
  const { user, company, can } = useAuth();
  const [state, setState] = useState({ loading: true });
  const [preset, setPreset] = useState('year'); const [custom, setCustom] = useState({ from: '', to: '' });
  const range = preset === 'custom' ? custom : PRESETS[preset][1]();

  useEffect(() => {
    if (preset === 'custom' && (!custom.from || !custom.to || custom.from > custom.to)) return;
    api.get('/dashboard/summary', { params: range }).then((r) => setState({ data: r.data.data })).catch((e) => setState({ error: errorMessage(e) }));
  }, [preset, custom.from, custom.to]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.loading) return <Spinner />;
  if (state.error) return <Alert tone="error">{state.error}</Alert>;
  const { team, kpis, charts, currency } = state.data;

  // Etapes de demarrage calculees a partir de donnees reelles
  const steps = [
    { done: !!company.taxId, label: "Renseigner le matricule fiscal de l'entreprise", to: '/settings', show: can('settings.write') },
    { done: (team?.members ?? 1) > 1 || (team?.pendingInvitations ?? 0) > 0, label: 'Inviter un collaborateur', to: '/users', show: can('user.write') },
  ].filter((s) => s.show);

  return (
    <>
      <PageHeader title={`Bonjour ${user.fullName.split(' ')[0]}`} subtitle={company.name} />
      {!user.emailVerified && (
        <div className="mb-4">
          <Alert tone="info"><ResendVerification /></Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {steps.length > 0 && (
          <Card className="p-5 lg:col-span-2">
            <h2 className="mb-3 font-semibold text-slate-900">Pour démarrer</h2>
            <ul className="space-y-2">
              {steps.map((s) => (
                <li key={s.label} className="flex items-center gap-2 text-sm">
                  {s.done ? <CheckCircle2 size={18} className="text-green-600" aria-label="Fait" /> : <Circle size={18} className="text-slate-300" aria-label="À faire" />}
                  <Link to={s.to} className={s.done ? 'text-slate-500 line-through' : 'text-brand-700 hover:underline'}>{s.label}</Link>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-slate-500">Les étapes suivantes (clients, articles, premier devis) apparaîtront avec leurs modules.</p>
          </Card>
        )}
        {team && (
          <Card className="p-5">
            <div className="flex items-center gap-2 text-slate-500"><Users size={18} aria-hidden /> <h2 className="text-sm font-medium">Équipe</h2></div>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{team.members}</p>
            <p className="text-sm text-slate-500">membre{team.members > 1 ? 's' : ''} actif{team.members > 1 ? 's' : ''}</p>
            <p className="mt-2 text-sm text-slate-600">{team.pendingInvitations} invitation{team.pendingInvitations > 1 ? 's' : ''} en attente</p>
          </Card>
        )}
      </div>

      <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-semibold text-slate-900">Indicateurs</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select aria-label="Période" className="rounded-md border border-slate-300 bg-white px-3 py-2" value={preset} onChange={(e) => setPreset(e.target.value)}>{Object.entries(PRESETS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}<option value="custom">Personnalisée…</option></select>
          {preset === 'custom' && <><input aria-label="Du" type="date" className="rounded-md border border-slate-300 px-2 py-2" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /><input aria-label="Au" type="date" className="rounded-md border border-slate-300 px-2 py-2" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></>}
        </div>
      </div>
      <p className="mb-3 text-xs text-slate-500">Période : {fr(state.data.period.from)} → {fr(state.data.period.to)} · montants HT en {currency} · calculés par le serveur à partir de vos documents (brouillons et annulés exclus, avoirs déduits). Les soldes, impayés et la trésorerie sont à la date du jour.</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Object.entries(KPI_LABELS).filter(([k]) => kpis[k]).map(([k, label]) => { const v = kpis[k]; return (
          <Card key={k} className="p-4"><p className="text-sm text-slate-500">{label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${k === 'overdue' && v.count > 0 ? 'text-red-600' : 'text-slate-900'}`} data-testid={`kpi-${k}`}>{v.value === null ? '—' : v.unit === '%' ? `${v.value} %` : ['pending_quotes', 'low_stock'].includes(k) ? v.value : money(v.value, v.unit)}</p>
            <p className="mt-1 text-xs text-slate-500">{DETAIL[k]?.(v) ?? ''}</p>
            {k === 'treasury' && v.other?.map((o) => <p key={o.unit} className="text-xs text-slate-500">+ {money(o.value, o.unit)}</p>)}
            {k === 'low_stock' && v.items?.length > 0 && <ul className="mt-1 text-xs text-orange-700">{v.items.map((i) => <li key={i.id}>{i.name} : {i.quantity} / seuil {i.threshold}</li>)}</ul>}</Card>); })}
      </div>
      {charts && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {charts.revenueTrend && <Card className="p-5 lg:col-span-2"><h3 className="mb-2 font-semibold text-slate-900">Évolution du chiffre d'affaires (12 derniers mois, HT)</h3><BarChart data={charts.revenueTrend} cur={currency} label="Chiffre d'affaires par mois" /></Card>}
          {charts.salesByClient && <Card className="p-5"><h3 className="mb-3 font-semibold text-slate-900">Répartition des ventes par client</h3><HBars data={charts.salesByClient} cur={currency} /></Card>}
          {charts.paidVsUnpaid && <Card className="p-5"><h3 className="mb-3 font-semibold text-slate-900">Factures payées et impayées</h3><Donut data={charts.paidVsUnpaid} cur={currency} label="Payé et impayé" /></Card>}
          {charts.topProducts && <Card className="p-5"><h3 className="mb-3 font-semibold text-slate-900">Top produits et services</h3><HBars data={charts.topProducts} cur={currency} /></Card>}
          {charts.expensesByCategory && <Card className="p-5"><h3 className="mb-3 font-semibold text-slate-900">Dépenses par catégorie</h3><HBars data={charts.expensesByCategory} cur={currency} /></Card>}
        </div>
      )}
      <p className="mt-6 text-xs text-slate-500">{state.data.note}</p>
    </>
  );
}
